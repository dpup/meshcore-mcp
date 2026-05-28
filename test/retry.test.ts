/**
 * `withRetry` — bounded retry + exponential backoff on the injected clock. Sleeps
 * are SimClock-virtual, so the suite runs in real-time milliseconds.
 */
import { MeshCoreError, MeshCoreTimeoutError } from "@dpup/meshcore-ts";
import { SimClock } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import {
  backoffDelay,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  isTransientDeviceError,
  withRetry,
} from "../src/retry.js";

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

describe("backoffDelay", () => {
  it("follows the 0-based exponential curve, saturating at the cap", () => {
    // Defaults: base 200ms, cap 2000ms. Attempt 0 ⇒ base, doubling thereafter.
    expect(DEFAULT_BACKOFF_BASE_MS).toBe(200);
    expect(DEFAULT_BACKOFF_CAP_MS).toBe(2000);
    expect(backoffDelay(0)).toBe(200);
    expect(backoffDelay(1)).toBe(400);
    expect(backoffDelay(2)).toBe(800);
    expect(backoffDelay(3)).toBe(1600);
    expect(backoffDelay(4)).toBe(2000); // 3200 capped to 2000
    expect(backoffDelay(10)).toBe(2000); // stays at the cap
  });

  it("honours base/cap overrides", () => {
    expect(backoffDelay(0, { baseMs: 100, capMs: 800 })).toBe(100);
    expect(backoffDelay(2, { baseMs: 100, capMs: 800 })).toBe(400);
    expect(backoffDelay(4, { baseMs: 100, capMs: 800 })).toBe(800); // 1600 capped
  });

  it("matches withRetry's 1-based loop (attempt n ⇒ backoffDelay(n-1))", () => {
    // The reconnect daemon and withRetry must produce identical delays.
    expect(backoffDelay(1 - 1)).toBe(200);
    expect(backoffDelay(2 - 1)).toBe(400);
    expect(backoffDelay(3 - 1)).toBe(800);
  });
});
