/**
 * Lenient input coercion for tool/admin params — *compensating for fuzzy LLM
 * calls*. An agent may pass `"22 dBm"`, `62500` (Hz) for a kHz field, `"SF7"`,
 * or `"4/5"` for a coding rate; these helpers accept the obvious variants and
 * normalise to one canonical unit, then a strict range check produces a clear
 * error for anything genuinely out of bounds.
 *
 * The canonical units on the meshcore-mcp surface are **MHz** for frequency and
 * **kHz** for bandwidth (human- and CLI-friendly: `set radio 910.525,62.5,7,5`).
 * Conversion to the device-native wire units (frequency in kHz, bandwidth in
 * **Hz**) happens only at the `MeshCoreClient` boundary in `service/admin.ts`.
 */
import { z } from "zod";

/**
 * Parse a finite number from a number or a numeric-ish string, tolerating the
 * units and separators a fuzzy call tends to include (`"22"`, `"22 dBm"`,
 * `"50%"`, `"910.525 MHz"`, `"1,000"`). Returns `undefined` when nothing
 * parses, so a {@link z.preprocess} can fall through to a clear "expected
 * number" error rather than silently coercing junk.
 */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * A fuzzy-friendly numeric param: accepts a number or numeric string, then
 * applies `constrain` (range / integer). For simple numeric tool/admin params
 * (e.g. dBm, percent) where an LLM might quote units or pass a string.
 */
export function numeric(constrain: (s: z.ZodNumber) => z.ZodNumber, describe?: string) {
  const base = z.preprocess((v) => toNumber(v) ?? v, constrain(z.number()));
  return describe === undefined ? base : base.describe(describe);
}

/**
 * LoRa **centre frequency in MHz**. Tolerates kHz (`910525`) and Hz
 * (`910525000`) inputs by magnitude, normalising to MHz. Range 100–2500 MHz
 * (covers the 433/470/868/915/923/2400 bands).
 */
export const freqMhz = z
  .preprocess((v) => {
    const n = toNumber(v);
    if (n === undefined) return v;
    if (n >= 1e8) return n / 1e6; // Hz → MHz
    if (n >= 1e4) return n / 1e3; // kHz → MHz
    return n; // already MHz
  }, z.number().min(100).max(2500))
  .describe("centre frequency in MHz (e.g. 910.525); kHz/Hz also accepted");

/**
 * LoRa **bandwidth in kHz**. Tolerates the device-native Hz form (`62500` →
 * `62.5`). LoRa bandwidths run 7.8–500 kHz; the split at 1000 cleanly separates
 * a kHz value (≤ 500) from an Hz value (≥ 7800).
 */
export const bwKhz = z
  .preprocess((v) => {
    const n = toNumber(v);
    if (n === undefined) return v;
    return n >= 1000 ? n / 1000 : n; // Hz → kHz
  }, z.number().positive().max(1000))
  .describe("bandwidth in kHz (e.g. 62.5, 125, 250, 500); Hz (62500) also accepted");

/** Spreading factor 5–12. Accepts `"SF7"` / `"7"` / `7`. */
export const sf = z
  .preprocess((v) => (typeof v === "string" ? (toNumber(v) ?? v) : v), z.number().int().min(5).max(12))
  .describe("spreading factor, 5–12");

/** Coding rate 5–8 (the denominator of 4/5…4/8). Accepts `"4/5"` / `"CR5"` / `"5"` / `5`. */
export const cr = z
  .preprocess((v) => {
    if (typeof v === "string") {
      const frac = v.match(/4\s*\/\s*([5-8])/);
      if (frac) return Number(frac[1]);
      return toNumber(v) ?? v;
    }
    return v;
  }, z.number().int().min(5).max(8))
  .describe("coding rate 5–8 (the 'n' in 4/n); '4/5' also accepted");
