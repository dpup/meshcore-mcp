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

import type { MeshCoreClient, MeshCoreEvents } from "@dpup/meshcore-ts";

import type { Clock } from "../clock.js";
import { TrafficBuffer } from "./traffic-buffer.js";
import type { TrafficEvent, TrafficKind } from "./traffic-buffer.js";

/** Options for constructing a {@link MeshService}. */
export interface MeshServiceOptions {
  /**
   * Capacity of the recent-traffic ring buffer. Defaults to the
   * {@link TrafficBuffer} default (~500 events).
   */
  trafficCapacity?: number;
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

  // M2: nodeHealth(node?), surveyMesh()
  // M3: sendMessage(target, text), runAdmin(node, command, params?, dryRun?)
  // Deliberately omitted until then — kept off the surface so the class stays
  // cohesive and the tools have nothing to call prematurely.

  // --- internals ---------------------------------------------------------

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
