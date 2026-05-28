/**
 * Time formatting — the one home for the human, coarse "ago"/duration phrasing
 * and the clock-skew tolerance the rest of the server reasons about.
 *
 * MeshCore RTCs commonly run minutes-to-hours *ahead* of ours, so an elapsed
 * span can be slightly (or wildly) negative. Both renderers take an already-
 * computed span (elapsed ms / total seconds) — they never read the clock
 * themselves, keeping the "no `Date.now()` below the entrypoint" rule intact;
 * the caller subtracts an injected-clock `now()`.
 */

/** One hour in ms — the symmetric skew window for "heard recently" counts. */
export const HOUR_MS = 3_600_000;

/** One day in ms. */
const DAY_MS = 86_400_000;

/**
 * Coarse-grained forward-skew tolerance for {@link formatRelative}: a span more
 * negative than this (node RTC days ahead, or an epoch-0 timestamp read as
 * "decades in the future") is bogus, not "just now". This is *separate* from
 * the {@link HOUR_MS} "heard recently" window — they answer different questions.
 */
const FORWARD_SKEW_TOLERANCE_MS = 2 * DAY_MS;

/** A span beyond this is implausible (e.g. an epoch-0 last-heard) → "unknown". */
const MAX_PLAUSIBLE_ELAPSED_MS = 3650 * DAY_MS;

const SECS_PER_MIN = 60;
const SECS_PER_HOUR = 3_600;
const SECS_PER_DAY = 86_400;

/**
 * Split a non-negative seconds count into whole day/hour/minute/second
 * components (the remainder after the larger units). This is
 * {@link formatDuration}'s helper — {@link formatRelative} does *not* call it
 * (it rounds, rather than truncating into fixed buckets). What the two renderers
 * share is the day/hour/minute/second unit constants, which live in exactly one
 * place; the splitting itself is `formatDuration`-only.
 */
function splitDhms(totalSecs: number): { d: number; h: number; m: number; s: number } {
  return {
    d: Math.floor(totalSecs / SECS_PER_DAY),
    h: Math.floor((totalSecs % SECS_PER_DAY) / SECS_PER_HOUR),
    m: Math.floor((totalSecs % SECS_PER_HOUR) / SECS_PER_MIN),
    s: Math.floor(totalSecs % SECS_PER_MIN),
  };
}

/**
 * Render an elapsed millisecond span as a coarse, human "ago" phrase
 * (`just now`, `5m ago`, `2h ago`, `3d ago`). Coarse on purpose — a precise
 * timestamp is noise in an error line (PRD §4).
 *
 * A small negative elapsed means the node's RTC runs *ahead* of ours — it was
 * heard ~now, not "unknown" (common: MeshCore RTCs skew minutes/hours forward).
 * A wildly-off value (far future, or an epoch-0 timestamp → decades) is bogus.
 *
 * The promotion ladder *rounds* at each boundary (so 90s → "2m ago", 36h →
 * "2d ago"); contrast `formatDuration`, which *truncates* into fixed d/h/m/s
 * buckets via `splitDhms`. This renderer does not call `splitDhms` — the two
 * share only the day/hour/minute/second unit constants.
 */
export function formatRelative(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return "unknown";
  if (elapsedMs < 0) return elapsedMs > -FORWARD_SKEW_TOLERANCE_MS ? "just now" : "unknown";
  if (elapsedMs > MAX_PLAUSIBLE_ELAPSED_MS) return "unknown";
  const secs = Math.floor(elapsedMs / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / SECS_PER_MIN);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Human duration from a seconds count (`1d 2h`, `3h 5m`, `45m`, `12s`). */
export function formatDuration(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) return "unknown";
  const { d, h, m, s } = splitDhms(totalSecs);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
