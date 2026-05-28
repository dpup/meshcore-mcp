/**
 * `withRetry` — bounded retry + exponential backoff on the injected clock. Sleeps
 * are SimClock-virtual, so the suite runs in real-time milliseconds.
 */
import { MeshCoreError, MeshCoreTimeoutError } from "@dpup/meshcore-ts";
import { SimClock } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { isTransientDeviceError, withRetry } from "../src/retry.js";

/** Tick microtasks so awaited backoff `setTimeout` callbacks chain through. */
async function tick(n = 64): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Advance the clock in fine slices, flushing microtasks between (settles awaits). */
async function advance(clock: SimClock, ms: number): Promise<void> {
  const step = 50;
  for (let e = 0; e < ms; e += step) {
    clock.advance(Math.min(step, ms - e));
    await tick();
  }
  await tick();
}

describe("withRetry", () => {
  it("returns immediately on first success — no clock advance needed", async () => {
    const clock = new SimClock();
    const got = await withRetry(async () => 42, { clock });
    expect(got).toBe(42);
  });

  it("retries a transient timeout and succeeds on the next attempt", async () => {
    const clock = new SimClock();
    let n = 0;
    const fn = async () => {
      n++;
      if (n === 1) throw new MeshCoreTimeoutError();
      return "ok";
    };
    const pending = withRetry(fn, { clock });
    await advance(clock, 300); // covers the 200ms first-retry backoff
    expect(await pending).toBe("ok");
    expect(n).toBe(2);
  });

  it("gives up after `attempts` and rethrows the last transient error", async () => {
    const clock = new SimClock();
    let n = 0;
    const fn = async () => {
      n++;
      throw new MeshCoreTimeoutError();
    };
    const pending = withRetry(fn, { clock, attempts: 3 }).catch((e) => e);
    await advance(clock, 5000); // > all backoff (200 + 400 ≈ 600ms) — well above
    const err = await pending;
    expect(err).toBeInstanceOf(MeshCoreTimeoutError);
    expect(n).toBe(3);
  });

  it("does not retry a non-transient error (e.g. a plain MeshCoreError 'not found')", async () => {
    const clock = new SimClock();
    let n = 0;
    const fn = async () => {
      n++;
      throw new MeshCoreError("device error: not found");
    };
    await expect(withRetry(fn, { clock })).rejects.toThrow(/not found/);
    expect(n).toBe(1);
  });

  it("the default predicate recognises typical transient strings", () => {
    expect(isTransientDeviceError(new MeshCoreTimeoutError())).toBe(true);
    expect(isTransientDeviceError(new MeshCoreError("device returned an error or did not respond"))).toBe(true);
    expect(isTransientDeviceError(new MeshCoreError("device error: not found"))).toBe(false);
  });

  it("backoff doubles per attempt up to the cap", async () => {
    const clock = new SimClock();
    const delays: number[] = [];
    let n = 0;
    const fn = async () => {
      n++;
      throw new MeshCoreTimeoutError();
    };
    const pending = withRetry(fn, {
      clock,
      attempts: 5,
      baseMs: 200,
      capMs: 800,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    }).catch(() => undefined);
    await advance(clock, 10_000);
    await pending;
    // Attempts 1..5 ⇒ 4 retries: 200, 400, 800, 800 (cap).
    expect(delays).toEqual([200, 400, 800, 800]);
    expect(n).toBe(5);
  });
});
