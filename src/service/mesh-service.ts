/**
 * `MeshService` — the device-facing core every tool, resource, and prompt calls.
 *
 * It is the seam the whole test strategy hangs on (execution plan §1): it takes
 * its {@link MeshCoreClient} and {@link Clock} by **injection** and constructs
 * neither. In production the entrypoint builds `MeshCoreClient.tcp(host, port)`
 * with a {@link SystemClock}; in tests it builds
 * `new MeshCoreClient(sim.asConnection())` with a `SimClock`. Nothing in here
 * knows — or may assume — which it got, and nothing here reads `Date.now()` or
 * schedules a native timer directly (PRD §6).
 *
 * Its one M1 job is to be the **live-traffic listener**: {@link start} connects
 * the client, subscribes to its named events, and maps each into a
 * {@link TrafficEvent} stamped with the injected clock and tagged with
 * structural provenance (the table below), feeding the {@link TrafficBuffer}.
 * {@link recentTraffic} reads that buffer back. The intent-shaped methods the
 * tools will call (`nodeHealth`, `surveyMesh`, `sendMessage`, `runAdmin`) land
 * in M2/M3.
 *
 * ### Event → TrafficEvent provenance mapping (M4 depends on this being exact)
 *
 * | meshcore-ts event       | kind          | decryptVerified | fields                    |
 * | ----------------------- | ------------- | --------------- | ------------------------- |
 * | `contactMessage`        | `contact`     | `true`          | sender=pubKeyPrefix, text |
 * | `channelMessage`        | `channel`     | `true`          | channelIdx, text          |
 * | `channelData`           | `channelData` | `false`         | channelIdx, snr           |
 * | `advert` / `newAdvert`  | `advert`      | `false`         | sender=publicKey          |
 * | `rawData` / `logRxData` | `raw`         | `false`         | rssi, snr                 |
 */

import type {
  Contact,
  MeshCoreClient,
  MeshCoreEvents,
  SelfInfo,
  Stats,
} from "@dpup/meshcore-ts";

import { MeshCoreError } from "@dpup/meshcore-ts";

import type { Clock } from "../clock.js";
import type { MeshSurvey, NodeHealth, SurveyContact } from "./health.js";
import { TrafficBuffer } from "./traffic-buffer.js";
import type { TrafficEvent, TrafficKind } from "./traffic-buffer.js";

/**
 * Thrown by {@link MeshService.nodeHealth} when `node` matches no known contact
 * (and is not the home node). A {@link MeshCoreError} subclass so the tool
 * layer's error formatter handles it on the same path as device errors.
 */
export class MeshServiceUnknownNodeError extends MeshCoreError {
  constructor(node: string) {
    super(`No contact matches "${node}"`);
    this.name = "MeshServiceUnknownNodeError";
  }
}

/**
 * Resolve a node's admin/login password. Injected so config (M6) can supply
 * per-node credentials without `MeshService` knowing where they came from.
 * Returning `undefined` (or no provider at all) means "guest" — the empty
 * password.
 */
export type CredentialsProvider = (node: string) => string | undefined;

/** Options for constructing a {@link MeshService}. */
export interface MeshServiceOptions {
  /**
   * Capacity of the recent-traffic ring buffer. Defaults to the
   * {@link TrafficBuffer} default (~500 events).
   */
  trafficCapacity?: number;
  /**
   * Resolve a node's admin/login password for the remote-{@link nodeHealth}
   * path. Defaults to the guest password (`""`) for every node. M6 wires this
   * from config; M2 only plumbs the seam.
   */
  credentials?: CredentialsProvider;
}

/**
 * The device-facing core: an injected {@link MeshCoreClient} + {@link Clock},
 * a recent-traffic buffer, and (later) the intent-shaped methods the MCP tools
 * call.
 *
 * @example
 * ```ts
 * const service = new MeshService(client, clock);
 * await service.start();
 * // ... traffic arrives as the clock advances ...
 * const events = service.recentTraffic();
 * await service.stop();
 * ```
 */
export class MeshService {
  /** The injected device client. Never constructed here. */
  private readonly client: MeshCoreClient;
  /** The injected clock. Sole source of time — no `Date.now()` below here. */
  private readonly clock: Clock;
  /** The recent-traffic ring buffer, fed by the event subscriptions. */
  private readonly buffer: TrafficBuffer;
  /** Resolve a node's login password; `undefined` ⇒ guest (`""`). */
  private readonly credentials: CredentialsProvider | undefined;
  /** Monotonic counter behind the `evt-<n>` ids. */
  private nextEventSeq = 1;
  /** Whether {@link start} has run (and subscriptions are live). */
  private started = false;
  /** The bound listeners, retained so {@link stop} can detach exactly these. */
  private readonly listeners: Array<{
    event: keyof MeshCoreEvents & string;
    fn: (...args: never[]) => void;
  }> = [];

  /**
   * @param client - An already-built {@link MeshCoreClient} (real or sim-backed).
   * @param clock - The injected {@link Clock} (`SystemClock` in prod, `SimClock`
   *   in tests). Stamps every buffered event.
   * @param options - Optional tuning (see {@link MeshServiceOptions}).
   */
  constructor(
    client: MeshCoreClient,
    clock: Clock,
    options: MeshServiceOptions = {},
  ) {
    this.client = client;
    this.clock = clock;
    this.buffer = new TrafficBuffer(options.trafficCapacity);
    this.credentials = options.credentials;
  }

  /**
   * Connect the client, subscribe to its live events, and begin feeding the
   * traffic buffer. Idempotent: a second call while started is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.subscribe();
    this.started = true;
    await this.client.connect();
  }

  /**
   * Unsubscribe from the client's events and close the connection. Safe to call
   * when not started.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.unsubscribe();
    this.started = false;
    await this.client.close();
  }

  /**
   * Recent live traffic, oldest→newest. With `since`, only events stamped at or
   * after that (injected-clock) time; otherwise the full retained window.
   */
  recentTraffic(since?: number): TrafficEvent[] {
    return since === undefined ? this.buffer.recent() : this.buffer.since(since);
  }

  /**
   * The current injected-clock time, in ms. The sole "now" the tool layer uses
   * for relative-time digests — never `Date.now()` (PRD §6).
   */
  now(): number {
    return this.clock.now();
  }

  /**
   * A consolidated health snapshot for one node, hiding the home-vs-remote
   * distinction and the remote login (PRD §4).
   *
   * With no `node` (or a `node` that resolves to the connected device) it
   * assembles the **home** snapshot from the structured companion-protocol
   * reads. Otherwise it resolves the contact, logs in (with the injected
   * credentials, default guest), and reads the **remote** repeater's status and
   * telemetry.
   *
   * An unreachable target makes the login/status reads reject with a
   * `MeshCoreError`/timeout; that is allowed to throw here — the tool layer
   * catches it and formats an actionable error result.
   *
   * @param node - A contact name or hex public-key prefix. Omitted ⇒ home.
   */
  async nodeHealth(node?: string): Promise<NodeHealth> {
    const self = await this.client.getSelfInfo();

    if (node === undefined || this.isHome(node, self)) {
      return this.homeHealth(self);
    }

    const contact = await this.resolveContact(node);
    if (contact === undefined) {
      // No such contact — treat it like the home node's own identity match, or
      // fall through to a remote attempt by key only if it looks like hex. A
      // plain unknown name has nothing to log in to, so surface it as an error
      // the tool layer formats (a MeshCoreError keeps the error path uniform).
      throw new MeshServiceUnknownNodeError(node);
    }

    // The home node may itself be listed as a contact; if the resolved contact
    // is the connected device, return the richer home snapshot.
    if (contact.publicKey === self.publicKey) {
      return this.homeHealth(self);
    }

    return this.remoteHealth(node, contact);
  }

  /**
   * One consolidated roster: the home node plus every known contact, each with
   * its last-heard time, role, and public key. Backs `survey_mesh`.
   */
  async surveyMesh(): Promise<MeshSurvey> {
    const [self, contacts] = await Promise.all([
      this.client.getSelfInfo(),
      this.client.getContacts(),
    ]);

    const roster: SurveyContact[] = contacts.map((c) => ({
      name: c.advName,
      publicKey: c.publicKey,
      role: c.type,
      lastHeardMs: c.lastAdvert.getTime(),
    }));

    return {
      home: { name: self.name, publicKey: self.publicKey, role: self.type },
      contacts: roster,
    };
  }

  // M3: sendMessage(target, text), runAdmin(node, command, params?, dryRun?)
  // Deliberately omitted until then — kept off the surface so the class stays
  // cohesive and the tools have nothing to call prematurely.

  // --- internals ---------------------------------------------------------

  /**
   * Whether `node` refers to the connected home device — by its advertised
   * name or by a hex prefix of its public key. Used to route a named/keyed
   * `nodeHealth` request to the home snapshot rather than a remote login.
   */
  private isHome(node: string, self: SelfInfo): boolean {
    if (node === self.name) return true;
    const ref = node.toLowerCase();
    return /^[0-9a-f]+$/.test(ref) && self.publicKey.startsWith(ref);
  }

  /**
   * Resolve a contact by advertised name, then (failing that) by hex
   * public-key prefix. Returns `undefined` when neither matches.
   */
  private async resolveContact(node: string): Promise<Contact | undefined> {
    const byName = await this.client.findContactByName(node);
    if (byName !== undefined) return byName;
    if (/^[0-9a-f]+$/i.test(node)) {
      return this.client.findContactByPublicKeyPrefix(node.toLowerCase());
    }
    return undefined;
  }

  /**
   * Assemble the **home** snapshot from the structured companion-protocol
   * reads: identity + radio config (`getSelfInfo`), battery, device time, and
   * the three stat groups. Stat reads are gathered together; a missing field
   * stays absent rather than synthesized.
   */
  private async homeHealth(self: SelfInfo): Promise<NodeHealth> {
    const [battery, deviceTime, core, radio, packets] = await Promise.all([
      this.client.getBatteryVoltage(),
      this.client.getDeviceTime(),
      this.client.getStatsCore(),
      this.client.getStatsRadio(),
      this.client.getStatsPackets(),
    ]);

    const stats: NonNullable<NodeHealth["stats"]> = {};
    let uptimeSecs: number | undefined;
    let txQueueLen: number | undefined;
    let batteryMilliVolts = battery.milliVolts;

    for (const s of [core, radio, packets] as Stats[]) {
      if (s.type === "core") {
        uptimeSecs = s.uptimeSecs;
        txQueueLen = s.queueLen;
        if (s.batteryMilliVolts > 0) batteryMilliVolts = s.batteryMilliVolts;
      } else if (s.type === "radio") {
        stats.noiseFloor = s.noiseFloor;
        stats.lastRssi = s.lastRssi;
        stats.lastSnr = s.lastSnr;
      } else {
        stats.packetsReceived = s.recv;
        stats.packetsSent = s.sent;
        stats.recvFlood = s.recvFlood;
        stats.recvDirect = s.recvDirect;
        stats.sentFlood = s.sentFlood;
        stats.sentDirect = s.sentDirect;
      }
    }

    return {
      kind: "home",
      node: self.name,
      publicKey: self.publicKey,
      role: self.type,
      reachable: true,
      lastHeardMs: deviceTime.getTime(),
      deviceTimeMs: deviceTime.getTime(),
      battery: { milliVolts: batteryMilliVolts, volts: batteryMilliVolts / 1000 },
      radio: {
        freqKhz: self.radioFreq,
        bwKhz: self.radioBw,
        sf: self.radioSf,
        cr: self.radioCr,
        txPower: self.txPower,
        maxTxPower: self.maxTxPower,
      },
      uptimeSecs,
      txQueueLen,
      stats,
    };
  }

  /**
   * Assemble a **remote** snapshot: log in (guest by default, or the injected
   * credential), then read the repeater's status and telemetry. Login/status
   * reject for an unreachable node — that rejection propagates to the caller.
   * Telemetry is reported only as an opaque byte length (PRD §4).
   */
  private async remoteHealth(node: string, contact: Contact): Promise<NodeHealth> {
    const password = this.credentials?.(node) ?? "";
    await this.client.login(contact, password);
    const status = await this.client.getStatus(contact);

    // Telemetry is best-effort: a node may report none. A failure here must not
    // sink an otherwise-good status snapshot, so swallow it to undefined.
    let telemetryBytes: number | undefined;
    try {
      const telemetry = await this.client.getTelemetry(contact);
      telemetryBytes = telemetry.lppSensorData.length;
    } catch {
      telemetryBytes = undefined;
    }

    return {
      kind: "remote",
      node: contact.advName || node,
      publicKey: contact.publicKey,
      role: contact.type,
      reachable: true,
      lastHeardMs: contact.lastAdvert.getTime(),
      battery: { milliVolts: status.batteryMilliVolts, volts: status.batteryMilliVolts / 1000 },
      uptimeSecs: status.totalUpTimeSecs,
      txQueueLen: status.currTxQueueLen,
      stats: {
        packetsReceived: status.packetsReceived,
        packetsSent: status.packetsSent,
        recvFlood: status.recvFlood,
        recvDirect: status.recvDirect,
        sentFlood: status.sentFlood,
        sentDirect: status.sentDirect,
        noiseFloor: status.noiseFloor,
        lastRssi: status.lastRssi,
        lastSnr: status.lastSnr,
        totalAirTimeSecs: status.totalAirTimeSecs,
        errEvents: status.errEvents,
      },
      telemetryBytes,
    };
  }

  /**
   * Wire one listener per source event, each mapping into a {@link TrafficEvent}
   * and pushing it to the buffer. Listeners are recorded so {@link unsubscribe}
   * can detach exactly these references.
   */
  private subscribe(): void {
    this.listen("contactMessage", (m) =>
      this.record("contact", true, { sender: m.pubKeyPrefix, text: m.text }),
    );
    this.listen("channelMessage", (m) =>
      this.record("channel", true, { channelIdx: m.channelIdx, text: m.text }),
    );
    this.listen("channelData", (d) =>
      this.record("channelData", false, { channelIdx: d.channelIdx, snr: d.snr }),
    );
    this.listen("advert", (a) =>
      this.record("advert", false, { sender: a.publicKey }),
    );
    this.listen("newAdvert", (a) =>
      this.record("advert", false, { sender: a.publicKey }),
    );
    this.listen("rawData", (d) =>
      this.record("raw", false, { rssi: d.lastRssi, snr: d.lastSnr }),
    );
    this.listen("logRxData", (d) =>
      this.record("raw", false, { rssi: d.lastRssi, snr: d.lastSnr }),
    );
  }

  /**
   * Register a typed listener on the client and remember it for teardown. The
   * stored reference is the exact function passed to `client.on`, so
   * `client.off` removes precisely it. The event name narrows the listener's
   * argument tuple via the client's typed event map.
   */
  private listen<E extends keyof MeshCoreEvents & string>(
    event: E,
    fn: (...args: MeshCoreEvents[E]) => void,
  ): void {
    this.client.on(event, fn);
    this.listeners.push({ event, fn: fn as (...args: never[]) => void });
  }

  /** Detach every listener registered by {@link subscribe}. */
  private unsubscribe(): void {
    for (const { event, fn } of this.listeners) {
      // `event` and `fn` were registered together with matching types; the
      // erased tuple type prevents TS re-correlating them here, so detach via
      // a single concrete-but-erased overload.
      (
        this.client.off as unknown as (
          e: string,
          f: (...args: never[]) => void,
        ) => void
      )(event, fn);
    }
    this.listeners.length = 0;
  }

  /**
   * Build a {@link TrafficEvent} — server id + injected-clock stamp + structural
   * provenance — and push it to the buffer. `fields` carries only the
   * event-specific provenance for this `kind`; absent fields stay absent.
   */
  private record(
    kind: TrafficKind,
    decryptVerified: boolean,
    fields: Pick<
      TrafficEvent,
      "sender" | "channelIdx" | "text" | "rssi" | "snr"
    >,
  ): void {
    const event: TrafficEvent = {
      id: `evt-${this.nextEventSeq++}`,
      at: this.clock.now(),
      kind,
      decryptVerified,
      ...fields,
    };
    this.buffer.push(event);
  }
}
