/**
 * The injectable clock — meshcore-mcp's time seam (PRD §6 design rule).
 *
 * Nothing below the entrypoint reads `Date.now()` or schedules a native
 * `setTimeout` directly. Everything takes time from a
 * {@link Clock}: {@link SystemClock} in production (real wall-clock + native
 * timers), `SimClock` from `@dpup/meshcore-sim` in tests (a deterministic
 * virtual clock you advance by hand). That single injection is what makes the
 * time-domain behaviour — recent-traffic windows, debounce, ordering — testable
 * without sleeping real seconds.
 *
 * The interface is **owned here but satisfied structurally by the sim**: it is
 * a strict subset of `@dpup/meshcore-sim`'s `Clock`
 * (`now`/`setTimeout`/`clearTimeout`, the same {@link Duration} and
 * {@link TimerHandle} types), so a `SimClock` is assignable to a `Clock` with no
 * adapter. The test suite asserts that compatibility
 * (`const _c: Clock = new SimClock()`).
 */

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/**
 * A span of time.
 *
 * Either a number of milliseconds, or a string with a unit suffix:
 * `"500ms"`, `"30s"`, `"2m"`, `"1h"`. The numeric part may be fractional
 * (e.g. `"1.5s"`). Mirrors `@dpup/meshcore-sim`'s `Duration`.
 */
export type Duration = number | string;

/** Unit suffixes recognized by {@link toMillis}, longest-first. */
const UNITS: ReadonlyArray<readonly [suffix: string, millis: number]> = [
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
];

/**
 * Resolve a {@link Duration} to a millisecond count.
 *
 * A number is returned as-is (after validation); a string is parsed by its
 * unit suffix. The result must be a finite, non-negative number. Mirrors the
 * sim's `toMillis` so durations are interchangeable across the two clocks.
 *
 * @throws {RangeError} If the value is not a valid, non-negative duration.
 */
export function toMillis(d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d < 0) {
      throw new RangeError(
        `Invalid duration: ${d} (expected a finite, non-negative number of ms)`,
      );
    }
    return d;
  }

  const trimmed = d.trim();
  for (const [suffix, scale] of UNITS) {
    if (trimmed.endsWith(suffix)) {
      const numeric = trimmed.slice(0, -suffix.length).trim();
      const value = Number(numeric);
      if (numeric === "" || !Number.isFinite(value) || value < 0) {
        throw new RangeError(
          `Invalid duration: "${d}" (bad numeric part before "${suffix}")`,
        );
      }
      return value * scale;
    }
  }

  throw new RangeError(
    `Invalid duration: "${d}" (expected a number of ms or a string like "30s", "500ms", "2m", "1h")`,
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An opaque handle returned by {@link Clock.setTimeout}. Pass it to
 * {@link Clock.clearTimeout} to cancel the timer.
 *
 * The shape is intentionally opaque — callers must not inspect its fields — and
 * is identical to `@dpup/meshcore-sim`'s `TimerHandle` so the two clocks are
 * interchangeable.
 */
export type TimerHandle = { readonly __timerId: number };

/**
 * The minimal clock interface meshcore-mcp injects.
 *
 * In production the entrypoint supplies a {@link SystemClock} backed by
 * `Date.now()` and `globalThis.setTimeout`; in tests it supplies
 * `@dpup/meshcore-sim`'s `SimClock`. Because the interface is this small (and a
 * deliberate mirror of the sim's), `SimClock` satisfies it structurally — no
 * adapter required.
 */
export interface Clock {
  /** Virtual (or wall-clock) milliseconds since the clock's epoch. */
  now(): number;

  /**
   * Schedule `callback` to run after `delay` has elapsed.
   *
   * @returns A handle that can be passed to {@link clearTimeout}.
   */
  setTimeout(callback: () => void, delay: Duration): TimerHandle;

  /** Cancel a pending one-shot timer. No-op for unknown / already-fired handles. */
  clearTimeout(handle: TimerHandle): void;
}

// ---------------------------------------------------------------------------
// SystemClock
// ---------------------------------------------------------------------------

/**
 * The production {@link Clock}: real wall-clock time and native timers.
 *
 * Reads time from `Date.now()` and schedules on `globalThis.setTimeout`.
 * Native timer objects are wrapped into the opaque
 * `{ __timerId }` handle shape via an internal id→timer map, so callers never
 * see a platform-specific timer value and the handle is identical to the one
 * `SimClock` hands back.
 *
 * @example
 * ```ts
 * const clock = new SystemClock();
 * const h = clock.setTimeout(() => console.error("tick"), "30s");
 * clock.clearTimeout(h);
 * ```
 */
export class SystemClock implements Clock {
  /** Next handle id. */
  private nextId = 1;
  /** Live native timers, keyed by the public handle id. */
  private readonly timers = new Map<
    number,
    ReturnType<typeof globalThis.setTimeout>
  >();

  /** Current wall-clock time in milliseconds since the Unix epoch. */
  now(): number {
    return Date.now();
  }

  /**
   * Schedule a one-shot callback after `delay`. The native timer is registered
   * under a fresh handle id and removed once it fires.
   */
  setTimeout(callback: () => void, delay: Duration): TimerHandle {
    const id = this.nextId++;
    const timer = globalThis.setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, toMillis(delay));
    this.timers.set(id, timer);
    return { __timerId: id };
  }

  /** Cancel a pending one-shot timer. No-op for unknown / already-fired handles. */
  clearTimeout(handle: TimerHandle): void {
    const timer = this.timers.get(handle.__timerId);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this.timers.delete(handle.__timerId);
    }
  }
}
