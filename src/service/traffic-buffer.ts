/**
 * The recent-traffic ring buffer — a bounded, in-memory record of the live
 * events observed on the mesh, each stamped with provenance.
 *
 * It is the single source of truth behind both `get_recent_traffic` (M2) and
 * the subscribable `meshcore://traffic/live` resource (M4), so the
 * {@link TrafficEvent} shape is the contract those milestones read. The buffer
 * itself is deliberately dumb: {@link MeshService} owns the event→TrafficEvent
 * mapping (the provenance table) and pushes finished records here; the buffer
 * only bounds, orders, and queries them.
 *
 * **Provenance is structural.** `decryptVerified` is not a wire field — it is
 * derived from *which* client event produced the record (a verified
 * `contactMessage`/`channelMessage` vs. an unverified `channelData`/`rawData`).
 * The buffer preserves that distinction verbatim; it never infers or collapses
 * it.
 */

/**
 * The kind of mesh traffic an event represents — the structural axis the
 * `decryptVerified` provenance hangs off (see {@link MeshService}'s mapping).
 *
 * - `contact` — a direct message from a contact (verified).
 * - `channel` — a decrypt-verified channel message (verified).
 * - `channelData` — an unverified channel datagram (no decoded text).
 * - `advert` — a node advertisement (unverified).
 * - `raw` — a raw / RX-log datagram carrying signal metadata only (unverified).
 */
export type TrafficKind =
  | "contact"
  | "channel"
  | "channelData"
  | "advert"
  | "raw";

/**
 * One observed live event, with provenance.
 *
 * Reused verbatim by `get_recent_traffic` (M2) and the live resource (M4), so
 * every field is part of the public contract. Optional fields are present only
 * when the originating event carried them — never synthesized.
 */
export interface TrafficEvent {
  /** Server-assigned, monotonic id (e.g. `"evt-1"`). */
  id: string;
  /** The injected `clock.now()` value when the event was observed (ms). */
  at: number;
  /** What kind of traffic this is — the structural provenance axis. */
  kind: TrafficKind;
  /**
   * Whether the device decrypt-verified this traffic. Structural, per the
   * provenance table: `true` for `contact`/`channel`, `false` otherwise. Never
   * inferred from content.
   */
  decryptVerified: boolean;
  /** Sender, where known: a hex `pubKeyPrefix` or full `publicKey`. */
  sender?: string;
  /** Channel slot index, where the event is channel-scoped. */
  channelIdx?: number;
  /** Decoded text, where available (verified messages only). */
  text?: string;
  /** Received signal strength in dBm, where the event carried it. */
  rssi?: number;
  /** Received signal-to-noise ratio in dB, where the event carried it. */
  snr?: number;
}

/** Default ring-buffer capacity. */
export const DEFAULT_TRAFFIC_CAPACITY = 500;

/**
 * A bounded ring buffer of {@link TrafficEvent}s.
 *
 * Holds at most `capacity` events; once full, each {@link push} evicts the
 * oldest. Events are stored — and returned — oldest-first, in arrival order.
 *
 * @example
 * ```ts
 * const buf = new TrafficBuffer(500);
 * buf.push(evt);
 * buf.recent(20);       // up to 20 most-recent, oldest→newest
 * buf.since(cutoffMs);  // everything observed at/after cutoffMs
 * ```
 */
export class TrafficBuffer {
  /** Stored events, oldest first. */
  private readonly events: TrafficEvent[] = [];
  /** Maximum number of retained events. */
  private readonly capacity: number;
  /** Optional hook invoked synchronously after each push (M4 live subscription). */
  private onPushCb: ((event: TrafficEvent) => void) | undefined;

  /**
   * @param capacity - Maximum retained events (default
   *   {@link DEFAULT_TRAFFIC_CAPACITY}). Must be a positive integer.
   */
  constructor(capacity: number = DEFAULT_TRAFFIC_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `TrafficBuffer: capacity must be a positive integer (got ${capacity})`,
      );
    }
    this.capacity = capacity;
  }

  /**
   * Append an event, evicting the oldest if at capacity, then fire the
   * {@link onPush} hook (if any).
   */
  push(event: TrafficEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
    this.onPushCb?.(event);
  }

  /**
   * Events observed at or after `t` (`at >= t`), oldest→newest. The cutoff is
   * compared against the injected-clock `at` stamp, never wall-clock time.
   */
  since(t: number): TrafficEvent[] {
    return this.events.filter((e) => e.at >= t);
  }

  /**
   * The most-recent events, oldest→newest. With no `limit`, returns every
   * retained event; otherwise the last `limit` events.
   */
  recent(limit?: number): TrafficEvent[] {
    if (limit === undefined) return [...this.events];
    if (limit <= 0) return [];
    return this.events.slice(-limit);
  }

  /** Drop all retained events. */
  clear(): void {
    this.events.length = 0;
  }

  /** Number of currently retained events. */
  get size(): number {
    return this.events.length;
  }

  /**
   * Register a callback fired synchronously after every {@link push} — the hook
   * M4's live resource uses to emit `notifications/resources/updated`. Pass
   * `undefined` to clear it. Only one hook is supported.
   */
  onPush(cb: ((event: TrafficEvent) => void) | undefined): void {
    this.onPushCb = cb;
  }
}
