/**
 * Bounded retry + exponential backoff for device calls, driven by the **injected
 * clock** (so tests advance time deterministically via `SimClock` — no
 * wall-clock sleeps).
 *
 * **Idempotency is the caller's responsibility.** This helper is safe to wrap
 * around reads, `set-*` config writes, and `set_channel` (same args ⇒ same
 * outcome); it is **not** safe around `send_message`, `advert`, or `reboot` —
 * a non-idempotent operation retried after a partial wire commit can
 * re-transmit / re-act. For those, only the connection itself should retry
 * (handled by the reconnect daemon in `MeshService`).
 */
import { MeshCoreError, MeshCoreTimeoutError } from "@dpup/meshcore-ts";

import type { Clock } from "./clock.js";

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Injected clock (production: `SystemClock`; tests: `SimClock`). */
  clock: Clock;
  /** Total attempts. Default `3` (so up to 2 retries on transient errors). */
  attempts?: number;
  /** Base backoff in ms; doubles per attempt. Default `200`. */
  baseMs?: number;
  /** Cap on backoff in ms. Default `2000`. */
  capMs?: number;
  /** Predicate for whether to retry an error. Defaults to transient device errors. */
  isRetryable?: (err: unknown) => boolean;
  /** Optional hook fired before each retry (for stderr logging). */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

/**
 * The default retryable predicate — transient device errors that almost always
 * succeed on a second try: meshcore-ts timeouts, and `MeshCoreError`s whose
 * message names a timeout / no-response (the way the wrapper normalises the
 * various meshcore.js rejection shapes — see `errors.ts: normalizeRejection`).
 */
export function isTransientDeviceError(err: unknown): boolean {
  if (err instanceof MeshCoreTimeoutError) return true;
  if (err instanceof MeshCoreError) {
    const m = err.message.toLowerCase();
    if (m.includes("did not respond") || m.includes("timed out") || m.includes("timeout")) {
      return true;
    }
  }
  return false;
}

/** Promise-ified sleep on the injected clock. */
function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(() => resolve(), ms);
  });
}

/**
 * Run `fn` with bounded retry + exponential backoff on transient errors.
 *
 * Returns `fn`'s result on the first success; rethrows on the final failure or
 * on a non-retryable error (the original error type is preserved so callers /
 * the `toolError` formatter can still match on `MeshCoreTimeoutError` etc.).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 200;
  const cap = opts.capMs ?? 2000;
  const retryable = opts.isRetryable ?? isTransientDeviceError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) throw error;
      const delayMs = Math.min(cap, base * 2 ** (attempt - 1));
      opts.onRetry?.({ attempt, error, delayMs });
      await delay(opts.clock, delayMs);
    }
  }
  // Loop always returns or throws; satisfy TS exhaustiveness.
  throw lastError;
}
