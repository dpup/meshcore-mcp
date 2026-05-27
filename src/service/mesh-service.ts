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
  Channel,
  Contact,
  ContactMessage,
  MeshCoreClient,
  MeshCoreEvents,
  SelfInfo,
  Stats,
} from "@dpup/meshcore-ts";

import { MeshCoreError, TxtType } from "@dpup/meshcore-ts";

import type { Clock, TimerHandle } from "../clock.js";
import type { AdminCommandDef, RiskTier } from "./admin.js";
import { ADMIN_COMMANDS } from "./admin.js";
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
 * Thrown by {@link MeshService.runAdmin} when the request is malformed before
 * any device contact: an unknown `command`, params that fail the command's Zod
 * schema, or a scope mismatch (a `remote-only` command targeting the home
 * node). A {@link MeshCoreError} subclass so the tool layer's error formatter
 * surfaces it on the same `isError` path as device errors — actionable, never a
 * crash.
 */
export class AdminCommandError extends MeshCoreError {
  constructor(message: string) {
    super(message);
    this.name = "AdminCommandError";
  }
}

/**
 * The result of {@link MeshService.sendMessage}. A small, structured digest of
 * what was transmitted and where — not the raw `SentResult` frame.
 */
export interface SendMessageResult {
  /** How the target was resolved. */
  kind: "contact" | "channel";
  /** The resolved contact's display name (for `kind: "contact"`). */
  contact?: string;
  /** The resolved contact's hex public key (for `kind: "contact"`). */
  publicKey?: string;
  /** The resolved channel index (for `kind: "channel"`). */
  channelIdx?: number;
  /** The resolved channel name, where known (for `kind: "channel"`). */
  channelName?: string;
  /** The text transmitted. */
  text: string;
}

/**
 * The result of {@link MeshService.runAdmin}. A discriminated digest covering
 * the three outcomes:
 *
 * - **dry-run** — `dryRun: true`, a synthesized `preview`, no device contact;
 * - **home exec** — `dryRun: false`, dispatched via the structured
 *   `MeshCoreClient` method (no `reply`);
 * - **remote exec** — `dryRun: false`, dispatched via the
 *   `login → CliData → reply` handshake (carries the repeater's `reply` text).
 *
 * Every variant carries the `command` and its `tier` so the tool can surface
 * the per-command risk in its structured output.
 */
export interface AdminResult {
  /** The command that ran (its registry name). */
  command: string;
  /** The command's risk tier (execution plan §9). */
  tier: RiskTier;
  /** Whether this was a dry-run (no device contact). */
  dryRun: boolean;
  /** Where the command was dispatched (absent for a dry-run). */
  via?: "home" | "remote";
  /** The synthesized intent preview — present iff `dryRun`. */
  preview?: string;
  /** The repeater's CLI reply text — present for a remote exec. */
  reply?: string;
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
   * Resolve a node's admin/login password for the remote-{@link MeshService.nodeHealth}
   * path. Defaults to the guest password (`""`) for every node. M6 wires this
   * from config; M2 only plumbs the seam.
   */
  credentials?: CredentialsProvider;
  /**
   * How long {@link MeshService.runAdmin}'s remote path waits for the repeater's CLI reply
   * before giving up, as injected-clock ms. Scheduled on the {@link Clock} (never
   * a native timer). Defaults to 15s.
   */
  adminReplyTimeoutMs?: number;
}

/** Default wait for a remote admin CLI reply, in injected-clock ms. */
const DEFAULT_ADMIN_REPLY_TIMEOUT_MS = 15_000;

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
  /** How long the remote admin path waits for a CLI reply, in clock ms. */
  private readonly adminReplyTimeoutMs: number;
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
    this.adminReplyTimeoutMs =
      options.adminReplyTimeoutMs ?? DEFAULT_ADMIN_REPLY_TIMEOUT_MS;
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
   * Register a callback fired synchronously whenever a new {@link TrafficEvent}
   * is buffered — the bridge the subscribable `meshcore://traffic/live` resource
   * (M4) uses to emit `notifications/resources/updated`. The buffer supports a
   * single hook; pass `undefined` to clear it. Keeping this on `MeshService`
   * preserves the rule that resources go through the service, never the buffer
   * or client directly.
   */
  onTraffic(cb: ((event: TrafficEvent) => void) | undefined): void {
    this.buffer.onPush(cb);
  }

  /**
   * The device's contact list — the roster behind the `meshcore://contacts`
   * resource (M4). Returns the typed {@link Contact} models verbatim from the
   * client; resources never call the client directly.
   */
  async contacts(): Promise<Contact[]> {
    return this.client.getContacts();
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

  /**
   * Send a text message, resolving `target` as either a **contact** or a
   * **channel** and routing to the matching typed client method (PRD §5.1).
   *
   * Resolution order:
   * - `#name` or `#idx` — an explicit channel reference (the `#` is stripped);
   * - a bare integer (e.g. `"0"`) — a channel index;
   * - otherwise a contact by name, then by hex public-key prefix;
   * - failing all of those, a channel by name (a last resort for names that did
   *   not match a contact).
   *
   * Returns a small structured digest of what was sent and to whom/which
   * channel — not the raw `SentResult`. An unknown target throws a
   * {@link MeshServiceUnknownNodeError}, which the tool layer formats.
   */
  async sendMessage(target: string, text: string): Promise<SendMessageResult> {
    // An explicit channel reference: `#name` or `#idx`.
    if (target.startsWith("#")) {
      const ref = target.slice(1);
      const channel = await this.resolveChannel(ref);
      if (channel === undefined) {
        throw new MeshServiceUnknownNodeError(target);
      }
      await this.client.sendChannelTextMessage(channel.channelIdx, text);
      return {
        kind: "channel",
        channelIdx: channel.channelIdx,
        channelName: channel.name,
        text,
      };
    }

    // A bare integer is a channel index.
    if (/^\d+$/.test(target)) {
      const idx = Number(target);
      const channel = await this.resolveChannelByIndex(idx);
      await this.client.sendChannelTextMessage(idx, text);
      return {
        kind: "channel",
        channelIdx: idx,
        channelName: channel?.name,
        text,
      };
    }

    // Otherwise a contact by name or hex prefix.
    const contact = await this.resolveContact(target);
    if (contact !== undefined) {
      await this.client.sendTextMessage(contact, text);
      return {
        kind: "contact",
        contact: contact.advName || target,
        publicKey: contact.publicKey,
        text,
      };
    }

    // Last resort: a channel matched by name (no `#` prefix).
    const channel = await this.resolveChannel(target);
    if (channel !== undefined) {
      await this.client.sendChannelTextMessage(channel.channelIdx, text);
      return {
        kind: "channel",
        channelIdx: channel.channelIdx,
        channelName: channel.name,
        text,
      };
    }

    throw new MeshServiceUnknownNodeError(target);
  }

  /**
   * Run one enumerated `admin` command against `node` (execution plan §9, §6).
   *
   * Validates `command` against {@link ADMIN_COMMANDS} and `params` against the
   * command's Zod schema first — a bad command or params throws an
   * {@link AdminCommandError} before any device contact. Then:
   *
   * - **`dryRun`** — return the synthesized {@link AdminCommandDef.preview},
   *   touching nothing.
   * - **home node + a `home()` path** — dispatch the structured
   *   {@link MeshCoreClient} method.
   * - **remote node (or a `remote-only` command)** — resolve the contact,
   *   `login` (with the injected credentials, default guest), send each CLI
   *   string as `CliData`, and await the repeater's reply (the next
   *   `contactMessage` from that node, correlated by sender + timing, timed out
   *   on the injected clock). No explicit logout (none exists — §6).
   *
   * A `remote-only` command targeting the home node throws an
   * {@link AdminCommandError}. An unreachable/unknown remote rejects at `login`
   * (a `MeshCoreError`), which propagates for the tool layer to format.
   */
  async runAdmin(
    node: string,
    command: string,
    params: unknown,
    dryRun: boolean,
  ): Promise<AdminResult> {
    const def = ADMIN_COMMANDS[command];
    if (def === undefined) {
      const known = Object.keys(ADMIN_COMMANDS).join(", ");
      throw new AdminCommandError(
        `Unknown admin command "${command}". Known commands: ${known}.`,
      );
    }

    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(params)"}: ${i.message}`)
        .join("; ");
      throw new AdminCommandError(`Invalid params for "${command}": ${issues}.`);
    }
    const p = parsed.data;

    if (dryRun) {
      return {
        command,
        tier: def.tier,
        dryRun: true,
        preview: def.preview(node, p),
      };
    }

    const self = await this.client.getSelfInfo();
    const isHome = this.isHome(node, self);

    // Home dispatch: only when the node is home, the command is home-reachable,
    // and a structured path exists.
    if (isHome) {
      if (def.scope === "remote-only" || def.home === undefined) {
        throw new AdminCommandError(
          `Command "${command}" is remote-only and cannot run against the home node "${node}".`,
        );
      }
      await def.home(this.client, node, p);
      return { command, tier: def.tier, dryRun: false, via: "home" };
    }

    // Remote dispatch: login → CliData → await reply.
    return this.runAdminRemote(node, def, p);
  }

  // --- internals ---------------------------------------------------------

  /**
   * The remote admin handshake (§6): resolve the contact, `login` (guest by
   * default, or the injected credential), send each CLI string as a `CliData`
   * text message, then await the repeater's reply — the next `contactMessage`
   * from that node's `pubKeyPrefix`, correlated by sender + timing. There is no
   * explicit logout (none exists; sessions expire server-side). The captured
   * reply is also recorded by the traffic buffer — expected.
   */
  private async runAdminRemote(
    node: string,
    def: AdminCommandDef,
    params: unknown,
  ): Promise<AdminResult> {
    const contact = await this.resolveContact(node);
    if (contact === undefined) {
      // Nothing to log in to — surface it the same way an unreachable node is.
      throw new MeshServiceUnknownNodeError(node);
    }

    const password = this.credentials?.(node) ?? "";
    const { pubKeyPrefix } = await this.client.login(contact, password);

    const cli = def.remoteCli(params);
    const lines = Array.isArray(cli) ? cli : [cli];

    // Arm the reply listener *before* sending, so a fast reply cannot race past
    // it. The reply correlates by sender prefix + timing (§6); long output may
    // span multiple messages, but the first reply is the structured result.
    const replyPromise = this.awaitContactReply(pubKeyPrefix, this.adminReplyTimeoutMs);
    for (const line of lines) {
      await this.client.sendTextMessage(contact, line, TxtType.CliData);
    }
    const reply = await replyPromise;

    return { command: def.name, tier: def.tier, dryRun: false, via: "remote", reply };
  }

  /**
   * Await the next `contactMessage` from `pubKeyPrefix`, resolving with its
   * text, or rejecting on a {@link Clock}-scheduled timeout. Both paths clean up
   * the listener and the timer exactly once — no native timers (PRD §6).
   *
   * The reply is correlated by **sender + timing** (§6): the first
   * `contactMessage` whose `pubKeyPrefix` matches the logged-in node. The
   * captured message is also recorded by the traffic buffer (the service's own
   * subscription) — that is expected.
   */
  private awaitContactReply(pubKeyPrefix: string, timeoutMs: number): Promise<string> {
    const want = pubKeyPrefix.toLowerCase();
    return new Promise<string>((resolve, reject) => {
      let timer: TimerHandle | undefined;
      const onMessage = (m: ContactMessage): void => {
        if (m.pubKeyPrefix.toLowerCase() !== want) return;
        cleanup();
        resolve(m.text);
      };
      const cleanup = (): void => {
        this.client.off("contactMessage", onMessage);
        if (timer !== undefined) this.clock.clearTimeout(timer);
      };
      this.client.on("contactMessage", onMessage);
      timer = this.clock.setTimeout(() => {
        cleanup();
        reject(
          new MeshCoreError(
            `no reply from ${pubKeyPrefix} within ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
    });
  }

  /**
   * Resolve a channel by index or name (a `#`-stripped ref). A purely numeric
   * ref is an index; otherwise it is matched by name. Returns `undefined` when
   * neither matches.
   */
  private async resolveChannel(ref: string): Promise<Channel | undefined> {
    if (/^\d+$/.test(ref)) {
      return this.resolveChannelByIndex(Number(ref));
    }
    return this.client.findChannelByName(ref);
  }

  /**
   * Resolve a channel by its numeric index, returning `undefined` if the device
   * reports no such slot (a failed read is swallowed — the send itself still
   * goes out by index, the lookup is only to enrich the result digest).
   */
  private async resolveChannelByIndex(idx: number): Promise<Channel | undefined> {
    try {
      return await this.client.getChannel(idx);
    } catch {
      return undefined;
    }
  }

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
