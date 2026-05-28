/**
 * ReconnectDaemon lifecycle (T5): the auto-reconnect daemon extracted from
 * MeshService. Drives it with a manual clock + a fake client to assert the
 * attach/schedule/reconnect path, that stop()/detach() leave no live timers,
 * and that a failed connect reschedules with growing backoff — behavior that
 * was previously only covered indirectly via the live node.
 */
import { describe, expect, it, vi } from "vitest";

import type { MeshCoreClient } from "@dpup/meshcore-ts";

import type { Clock, Duration, TimerHandle } from "../src/clock.js";
import { toMillis } from "../src/clock.js";
import { ReconnectDaemon } from "../src/service/reconnect.js";

/** A clock whose scheduled callbacks fire only when the test pumps them. */
class ManualClock implements Clock {
  private q: Array<{ cb: () => void; delayMs: number }> = [];
  now(): number {
    return 0;
  }
  setTimeout(cb: () => void, duration: Duration): TimerHandle {
    this.q.push({ cb, delayMs: toMillis(duration) });
    return this.q.length as unknown as TimerHandle;
  }
  clearTimeout(): void {
    /* manual clock: handles are positional, nothing to cancel for these tests */
  }
  get pending(): number {
    return this.q.length;
  }
  /** Fire the next scheduled callback and flush the async reconnect attempt. */
  async fireNext(): Promise<number> {
    const t = this.q.shift();
    if (t === undefined) throw new Error("no pending timer");
    t.cb();
    // attemptReconnect is async (void-ed); let its awaits settle.
    await Promise.resolve();
    await Promise.resolve();
    return t.delayMs;
  }
}

/** A fake MeshCoreClient exposing just the on/off/connect the daemon touches. */
function fakeClient(connect: () => Promise<void>) {
  const handlers = new Map<string, Set<(...a: never[]) => void>>();
  const client = {
    on(ev: string, fn: (...a: never[]) => void) {
      (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn);
    },
    off(ev: string, fn: (...a: never[]) => void) {
      handlers.get(ev)?.delete(fn);
    },
    connect: vi.fn(connect),
  };
  const emitDisconnected = () => {
    for (const fn of handlers.get("disconnected") ?? []) (fn as () => void)();
  };
  return { client: client as unknown as MeshCoreClient, connect: client.connect, emitDisconnected, handlers };
}

describe("ReconnectDaemon", () => {
  it("schedules a reconnect on disconnect and reconnects on the injected clock", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const clock = new ManualClock();
    const { client, connect, emitDisconnected } = fakeClient(async () => {});
    const daemon = new ReconnectDaemon(client, clock);
    daemon.attach();

    emitDisconnected();
    expect(clock.pending).toBe(1); // one scheduled attempt, not yet fired
    expect(connect).not.toHaveBeenCalled();

    const waited = await clock.fireNext();
    expect(waited).toBe(200); // backoffDelay(0)
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(0); // success → no reschedule
    stderr.mockRestore();
  });

  it("does not schedule new attempts after stop()", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const clock = new ManualClock();
    const { client, connect, emitDisconnected } = fakeClient(async () => {});
    const daemon = new ReconnectDaemon(client, clock);
    daemon.attach();
    daemon.stop();

    emitDisconnected();
    expect(clock.pending).toBe(0); // stopped → nothing scheduled
    expect(connect).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("detach() unhooks the disconnected handler", () => {
    const clock = new ManualClock();
    const { client, emitDisconnected } = fakeClient(async () => {});
    const daemon = new ReconnectDaemon(client, clock);
    daemon.attach();
    daemon.detach();

    emitDisconnected();
    expect(clock.pending).toBe(0); // handler removed → no schedule
  });

  it("does not start a second connect when disconnected fires mid-connect", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const clock = new ManualClock();
    // A connect() that hangs until the test lets it resolve, so we can keep one
    // attempt in flight while a second `disconnected` arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, connect, emitDisconnected } = fakeClient(() => gate);
    const daemon = new ReconnectDaemon(client, clock);
    daemon.attach();

    // First disconnect → schedule → fire the timer, which clears `scheduled`
    // and enters attemptReconnect, awaiting the hung connect().
    emitDisconnected();
    expect(clock.pending).toBe(1);
    await clock.fireNext(); // begins the (still-pending) connect
    expect(connect).toHaveBeenCalledTimes(1);
    // `scheduled` is already cleared by the timer; only the `connecting` guard
    // protects the in-flight window now.

    // A second disconnect arrives while connect() is still pending. The
    // `connecting` guard must make scheduleReconnect a no-op — no second timer.
    emitDisconnected();
    expect(clock.pending).toBe(0); // no second schedule while connecting
    expect(connect).toHaveBeenCalledTimes(1); // still exactly one connect in flight

    // Let the connect resolve; success clears `connecting` with no reschedule.
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(0);
    stderr.mockRestore();
  });

  it("reschedules with growing backoff when a connect attempt fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const clock = new ManualClock();
    const connectImpl = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("link down"))
      .mockResolvedValue(undefined);
    const { client, emitDisconnected } = fakeClient(connectImpl);
    const daemon = new ReconnectDaemon(client, clock);
    daemon.attach();

    emitDisconnected();
    const first = await clock.fireNext();
    expect(first).toBe(200); // backoffDelay(0)
    expect(connectImpl).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(1); // failure → rescheduled

    const second = await clock.fireNext();
    expect(second).toBe(400); // backoffDelay(1) — doubled
    expect(connectImpl).toHaveBeenCalledTimes(2);
    expect(clock.pending).toBe(0); // success → no further reschedule
    stderr.mockRestore();
  });
});
