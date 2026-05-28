/**
 * The auto-reconnect daemon — the self-contained piece of {@link MeshService}'s
 * lifecycle that brings the device link back across a node reboot or WiFi blip.
 *
 * Like {@link MeshService} itself, it takes its {@link MeshCoreClient} and
 * {@link Clock} by **injection** and constructs neither: `MeshService` builds one
 * in its constructor (passing its own injected client + clock), {@link attach}es
 * it in `start()` (hooking `client.on("disconnected", …)`), and {@link detach}es
 * + {@link stop}s it in `stop()`. Nothing here reads `Date.now()` or schedules a
 * native timer — backoff is scheduled on the injected clock (PRD §6).
 *
 * The backoff curve is the shared {@link backoffDelay} policy (the same one
 * `withRetry` uses), with the attempt count as its 0-based index — so the first
 * schedule waits the base delay and each retry doubles up to the cap. The daemon
 * is re-entrant-safe (a single pending schedule at a time) and stops scheduling
 * new attempts once {@link stop} runs, so a stopped service leaves no live timers
 * chasing the device.
 */

import type { MeshCoreClient } from "@dpup/meshcore-ts";

import type { Clock } from "../clock.js";
import { backoffDelay } from "../retry.js";

/**
 * The auto-reconnect daemon. Construct it with the injected client + clock,
 * {@link attach} it onto the client's `disconnected` lifecycle event when the
 * service starts, and {@link detach} + {@link stop} it when the service stops.
 */
export class ReconnectDaemon {
  private readonly client: MeshCoreClient;
  private readonly clock: Clock;
  /** 0-based attempt index feeding {@link backoffDelay}; reset to 0 on success. */
  private attempt = 0;
  /** Re-entrancy guard — at most one pending scheduled attempt at a time. */
  private scheduled = false;
  /** Once {@link stop} runs, no new attempts are scheduled. */
  private stopping = false;
  /** The bound `disconnected` handler, retained so {@link detach} removes exactly it. */
  private readonly onDisconnected: () => void;

  /**
   * @param client - The injected {@link MeshCoreClient} (never constructed here).
   * @param clock - The injected {@link Clock} (`SystemClock` in prod, `SimClock`
   *   in tests). Backoff is scheduled on it — never a native timer.
   */
  constructor(client: MeshCoreClient, clock: Clock) {
    this.client = client;
    this.clock = clock;
    this.onDisconnected = () => {
      if (!this.stopping) this.scheduleReconnect();
    };
  }

  /**
   * Hook the daemon onto the client's lifecycle. On `disconnected` (node reboot,
   * WiFi blip), it schedules a reconnect with backoff; idempotent reads bridge
   * over via the retry path.
   */
  attach(): void {
    this.client.on("disconnected", this.onDisconnected);
  }

  /** Detach the `disconnected` handler — the exact reference {@link attach} bound. */
  detach(): void {
    this.client.off("disconnected", this.onDisconnected);
  }

  /**
   * Stop scheduling new reconnect attempts. After this, an in-flight
   * {@link attemptReconnect} bails out and {@link scheduleReconnect} is a no-op,
   * so a stopped service leaves no live timers chasing the device.
   */
  stop(): void {
    this.stopping = true;
  }

  /**
   * Schedule a reconnect attempt after exp backoff (capped). Re-entrant-safe via
   * `scheduled`. Stops scheduling new attempts once {@link stop} runs.
   *
   * The backoff curve is the shared {@link backoffDelay} policy (the same one
   * `withRetry` uses), with the attempt count as its 0-based index — so the
   * first schedule waits the base delay and each retry doubles up to the cap.
   */
  private scheduleReconnect(): void {
    if (this.scheduled || this.stopping) return;
    this.scheduled = true;
    const delayMs = backoffDelay(this.attempt);
    this.clock.setTimeout(() => {
      this.scheduled = false;
      void this.attemptReconnect();
    }, delayMs);
  }

  /** One reconnect attempt; on failure, reschedule with growing backoff. */
  private async attemptReconnect(): Promise<void> {
    if (this.stopping) return;
    this.attempt += 1;
    process.stderr.write(
      `meshcore-mcp: device disconnected; reconnect attempt ${this.attempt}…\n`,
    );
    try {
      await this.client.connect();
      this.attempt = 0;
      process.stderr.write("meshcore-mcp: device reconnected.\n");
    } catch (e) {
      process.stderr.write(
        `meshcore-mcp: reconnect failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      this.scheduleReconnect();
    }
  }
}
