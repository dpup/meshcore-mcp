/**
 * The enumerated, curated `admin` command set (execution plan §9, PRD §5.1, §8.1).
 *
 * `admin` is **never** free-form text. This module is the single source of truth
 * for what an agent may do to a node: a frozen registry of 16 typed commands,
 * each declaring
 *
 * - a **risk `tier`** (`read | benign | config | sensitive | destructive`) →
 *   MCP annotations via {@link annotationsForTier} (deterministic, AGENTS.md
 *   "risk tier → annotations is deterministic");
 * - a **`scope`** — `"home+remote"` (also reachable over the companion protocol)
 *   or `"remote-only"` (no companion-protocol equivalent, so only the repeater
 *   CLI can express it);
 * - a **Zod `params` schema** the `admin` tool validates the caller's params
 *   against;
 * - a **`preview(node, params)`** that synthesizes the dry-run intent text
 *   *without contacting the device* (PRD §5.3) — §9's per-command strings;
 * - an optional **`home(client, node, params)`** structured `MeshCoreClient`
 *   call (present for `home+remote` commands, absent for `remote-only`); and
 * - a **`remoteCli(params)`** producing the repeater CLI string(s) sent as
 *   `CliData` after `login` (§6).
 *
 * Dispatch (the home-vs-remote routing, login→CliData→reply handshake, and the
 * reply correlation) lives in {@link MeshService.runAdmin}; this module only
 * declares *what* each command is.
 */

import type { MeshCoreClient } from "@dpup/meshcore-ts";
import { z } from "zod";

import * as coerce from "../coerce.js";

/**
 * A command's risk tier. Maps deterministically to MCP annotations via
 * {@link annotationsForTier} (execution plan §9's table). The `read` tier is
 * present for completeness; queries are surfaced via `get_node_health`, not
 * `admin`, so no `admin` command currently uses it.
 */
export type RiskTier = "read" | "benign" | "config" | "sensitive" | "destructive";

/** Where a command can be dispatched. */
export type AdminScope = "home+remote" | "remote-only";

/**
 * One enumerated admin command. {@link MeshService.runAdmin} validates the
 * caller's `command` against the registry's keys (a bad name surfaces the
 * friendly known-command list — H8) and surfaces the `tier`'s
 * {@link annotationsForTier} triple in the structured output; adding a command
 * is one new {@link AdminCommandDef} entry (execution plan §9 "Adding a command
 * is one new entry").
 *
 * @typeParam P - The parsed shape of this command's params (inferred from
 *   {@link params}).
 */
export interface AdminCommandDef<P = unknown> {
  /** The enum value, e.g. `"set-tx-power"`. */
  name: string;
  /** Risk tier → annotations via {@link annotationsForTier}. */
  tier: RiskTier;
  /** Companion-protocol-reachable (`home+remote`) or CLI-only (`remote-only`). */
  scope: AdminScope;
  /**
   * When `true`, the command's params and/or the repeater's CLI reply carry a
   * secret (e.g. a password the repeater echoes back). The dispatch layer
   * ({@link MeshService.runAdmin}) MUST then suppress retention of the reply:
   * the secret-bearing `contactMessage` is buffered with its `text` omitted, and
   * the {@link AdminResult.reply} is withheld (a fixed notice replaces the raw
   * echo). Generic by design — any future command can opt in by setting this.
   */
  secret?: boolean;
  /** Zod params schema. An empty object schema when the command takes none. */
  params: z.ZodType<P>;
  /**
   * Synthesized dry-run text (execution plan §9). **MUST NOT contact the
   * device** — it describes intent only.
   */
  preview(node: string, p: P): string;
  /**
   * Home path: a structured {@link MeshCoreClient} call. Absent ⇒ the command
   * is `remote-only` (no companion-protocol equivalent).
   */
  home?(client: MeshCoreClient, node: string, p: P): Promise<unknown>;
  /** Remote path: the repeater CLI string(s) sent as `CliData` after `login`. */
  remoteCli(p: P): string | string[];
}

/**
 * The annotation triple a {@link RiskTier} maps to (execution plan §9's table).
 * `openWorldHint` is set by the tool (always `true` — every command touches the
 * mesh), so it is not part of the tier mapping.
 *
 * This triple is surfaced **in the structured output** of every `admin` result
 * ({@link AdminResult.annotations}), not as MCP tool-level annotations: `admin`
 * is a single multiplexed tool, so its tool-level annotations are conservative
 * and static (a single invocation can't carry per-command hints).
 */
export interface TierAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/**
 * Map a {@link RiskTier} to its `{ readOnlyHint, destructiveHint,
 * idempotentHint }` triple — the deterministic table from execution plan §9.
 * `sensitive` is annotated like `destructive` (gated) but stays idempotent.
 */
export function annotationsForTier(tier: RiskTier): TierAnnotations {
  switch (tier) {
    case "read":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    case "benign":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    case "config":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
    case "sensitive":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
    case "destructive":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  }
}

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

/** The shared empty-params schema for commands that take none. */
const NO_PARAMS = z.object({}).strict();

/** Permission levels for `set-permission`. `null` ⇒ remove. */
const PERMISSION_LEVELS = ["guest", "read", "readwrite", "admin"] as const;

/** Map a `set-permission` level name to its CLI numeric (`setperm <key> <0–3>`). */
const PERMISSION_LEVEL_VALUE: Record<(typeof PERMISSION_LEVELS)[number], number> = {
  guest: 0,
  read: 1,
  readwrite: 2,
  admin: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a typed {@link AdminCommandDef}. A thin constructor that pins `P` to the
 * schema's inferred output so each command's `preview`/`home`/`remoteCli` see
 * the parsed params, and erases back to `AdminCommandDef<unknown>` for the
 * registry (whose values are heterogeneous).
 */
function define<S extends z.ZodType>(
  def: Omit<AdminCommandDef<z.output<S>>, "params"> & { params: S },
): AdminCommandDef {
  return def as unknown as AdminCommandDef;
}

// ---------------------------------------------------------------------------
// The registry (execution plan §9 — the 16 commands)
// ---------------------------------------------------------------------------

/**
 * The frozen registry of every enumerated `admin` command (execution plan §9).
 * Keyed by `command` name; {@link MeshService.runAdmin} dispatches on these keys
 * (see {@link ADMIN_COMMAND_NAMES} for why validation is by lookup, not a Zod
 * enum).
 */
export const ADMIN_COMMANDS: Readonly<Record<string, AdminCommandDef>> = Object.freeze({
  reboot: define({
    name: "reboot",
    tier: "destructive",
    scope: "home+remote",
    params: NO_PARAMS,
    preview: (node) =>
      `Reboot ${node}. Unreachable for ~30–60s while it restarts; any session ends.`,
    home: (client) => client.reboot(),
    remoteCli: () => "reboot",
  }),

  advert: define({
    name: "advert",
    tier: "benign",
    scope: "home+remote",
    params: z.object({
      mode: z.enum(["flood", "zerohop"]).default("flood").describe("flood (mesh-wide) or zerohop (neighbours only)"),
    }),
    preview: (node, p) =>
      `${node} broadcasts a ${p.mode} advert now. Costs airtime; floods propagate mesh-wide.`,
    home: (client, _node, p) =>
      p.mode === "zerohop" ? client.sendZeroHopAdvert() : client.sendFloodAdvert(),
    remoteCli: (p) => (p.mode === "zerohop" ? "advert.zerohop" : "advert"),
  }),

  "sync-time": define({
    name: "sync-time",
    tier: "benign",
    scope: "home+remote",
    params: NO_PARAMS,
    preview: (node) =>
      `Set ${node}'s clock to the controller's time. No-op if already in sync.`,
    home: (client) => client.syncDeviceTime(),
    remoteCli: () => "clock sync",
  }),

  "set-tx-power": define({
    name: "set-tx-power",
    tier: "config",
    scope: "home+remote",
    params: z.object({ dbm: coerce.numeric((s) => s.int().min(1).max(22), "transmit power in dBm, 1–22") }),
    preview: (node, p) =>
      `Set ${node} TX power to ${p.dbm} dBm. ⚠ Confirm legal for your band/region; some boards add a PA stage on top.`,
    home: (client, _node, p) => client.setTxPower(p.dbm),
    remoteCli: (p) => `set tx ${p.dbm}`,
  }),

  "set-radio": define({
    name: "set-radio",
    tier: "config",
    scope: "home+remote",
    params: z.object({
      freqMhz: coerce.freqMhz,
      bwKhz: coerce.bwKhz,
      sf: coerce.sf,
      cr: coerce.cr,
    }),
    preview: (node, p) =>
      `Set ${node} radio to ${p.freqMhz} MHz / ${p.bwKhz} kHz / SF${p.sf} / CR${p.cr}. ` +
      `⚠ Applies after a reboot; if it stops matching the mesh, ${node} drops off the network.`,
    // The device wire units are kHz for frequency and **Hz** for bandwidth
    // (confirmed against a live node: 869.618 MHz → radioFreq 869618; 62.5 kHz →
    // radioBw 62500). Our params are MHz / kHz, so scale both by 1000 here.
    home: (client, _node, p) =>
      client.setRadioParams(
        Math.round(p.freqMhz * 1000),
        Math.round(p.bwKhz * 1000),
        p.sf,
        p.cr,
      ),
    // The repeater CLI `set radio` takes MHz and kHz directly — pass through.
    remoteCli: (p) => `set radio ${p.freqMhz},${p.bwKhz},${p.sf},${p.cr}`,
  }),

  "set-name": define({
    name: "set-name",
    tier: "config",
    scope: "home+remote",
    // ≤32 bytes (UTF-8), per §9.
    params: z.object({
      name: z
        .string()
        .refine((n) => Buffer.byteLength(n, "utf8") <= 32, {
          message: "name must be at most 32 bytes",
        })
        .describe("advertised name, ≤32 bytes"),
    }),
    preview: (node, p) =>
      `Rename ${node} to "${p.name}" (max 32 bytes, 24 if a location is set).`,
    home: (client, _node, p) => client.setAdvertName(p.name),
    remoteCli: (p) => `set name ${p.name}`,
  }),

  "set-location": define({
    name: "set-location",
    tier: "config",
    scope: "home+remote",
    params: z.object({
      lat: z.number().describe("latitude in degrees"),
      lon: z.number().describe("longitude in degrees"),
    }),
    preview: (node, p) => `Set ${node}'s advertised location to ${p.lat}, ${p.lon}.`,
    home: (client, _node, p) => client.setAdvertLatLong(p.lat, p.lon),
    // The repeater CLI sets lat/lon separately (§9): `set lat <lat>` + `set lon <lon>`.
    remoteCli: (p) => [`set lat ${p.lat}`, `set lon ${p.lon}`],
  }),

  "set-admin-password": define({
    name: "set-admin-password",
    tier: "sensitive",
    scope: "remote-only",
    secret: true,
    params: z.object({ password: z.string().max(15).describe("new admin password, ≤15 chars") }),
    preview: (node) =>
      `Change ${node}'s admin password. ⚠ Sent over the mesh as CliData and echoed in the reply; ` +
      `mis-setting can lock out admins. Secret — must not be retained in the traffic buffer.`,
    remoteCli: (p) => `password ${p.password}`,
  }),

  "set-repeat": define({
    name: "set-repeat",
    tier: "config",
    scope: "remote-only",
    params: z.object({ enabled: z.boolean().describe("true to enable packet repeating") }),
    preview: (node, p) =>
      `Turn packet repeating ${p.enabled ? "on" : "off"} on ${node}.` +
      (p.enabled ? "" : ` ⚠ 'off' stops ${node} relaying mesh traffic.`),
    remoteCli: (p) => `set repeat ${p.enabled ? "on" : "off"}`,
  }),

  "set-dutycycle": define({
    name: "set-dutycycle",
    tier: "config",
    scope: "remote-only",
    params: z.object({ percent: coerce.numeric((s) => s.int().min(1).max(100), "duty-cycle limit, 1–100 (percent)") }),
    preview: (node, p) =>
      `Set ${node} duty-cycle limit to ${p.percent}%. ` +
      `(firmware ≥ 1.15; older nodes use the airtime-factor knob.)`,
    remoteCli: (p) => `set dutycycle ${p.percent}`,
  }),

  "log-start": define({
    name: "log-start",
    tier: "benign",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) => `Begin capturing ${node}'s RX log to storage.`,
    remoteCli: () => "log start",
  }),

  "log-stop": define({
    name: "log-stop",
    tier: "benign",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) => `Stop capturing ${node}'s RX log to storage.`,
    remoteCli: () => "log stop",
  }),

  "log-erase": define({
    name: "log-erase",
    tier: "destructive",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) => `Erase ${node}'s captured RX log. ⚠ The capture is lost.`,
    remoteCli: () => "log erase",
  }),

  "clear-stats": define({
    name: "clear-stats",
    tier: "destructive",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) =>
      `Reset ${node}'s packet/radio counters to zero. ⚠ Historical counts are lost.`,
    remoteCli: () => "clear stats",
  }),

  "remove-neighbor": define({
    name: "remove-neighbor",
    tier: "destructive",
    scope: "remote-only",
    params: z.object({
      pubKeyPrefix: z.string().regex(/^[0-9a-fA-F]+$/, "expected a hex prefix").describe("hex public-key prefix"),
    }),
    preview: (node, p) =>
      `Remove neighbour(s) matching prefix ${p.pubKeyPrefix} from ${node}'s list.`,
    remoteCli: (p) => `neighbor.remove ${p.pubKeyPrefix.toLowerCase()}`,
  }),

  "set-permission": define({
    name: "set-permission",
    tier: "sensitive",
    scope: "remote-only",
    params: z.object({
      pubKey: z.string().regex(/^[0-9a-fA-F]+$/, "expected a hex public key").describe("hex public key"),
      level: z
        .enum(PERMISSION_LEVELS)
        .nullable()
        .describe(
          "guest|read|readwrite|admin, or null to revoke (downgrade to guest — " +
            "the firmware has no explicit removal, only a level-0 demotion)",
        ),
    }),
    preview: (node, p) =>
      `Set ${p.pubKey}'s permission on ${node} to ${p.level ?? "guest (revoke)"}.` +
      (p.level === "admin" ? ` ⚠ 'admin' grants full control of ${node}.` : ""),
    // Firmware parses `setperm <pubkey> <0–3>` via `strchr(' ')` — a bare
    // `setperm <pk>` with no space + level returns "Err - bad params". There
    // is no explicit removal form; setting permission 0 (guest) is the
    // de-facto revoke. `level: null` therefore emits level 0.
    remoteCli: (p) => {
      const key = p.pubKey.toLowerCase();
      const value = p.level === null ? 0 : PERMISSION_LEVEL_VALUE[p.level];
      return `setperm ${key} ${value}`;
    },
  }),

  // ---------- routing / flood control ------------------------------------

  "set-path-hash-mode": define({
    name: "set-path-hash-mode",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      mode: coerce.numeric(
        (s) => s.int().min(0).max(2),
        "path-hash mode 0|1|2 (1-byte/2-byte/3-byte advertised prefixes; 64/32/21 flood cap respectively)",
      ),
    }),
    preview: (node, p) =>
      `Set ${node} path-hash mode to ${p.mode}. ⚠ Changes advertised prefix length and flood cap — must match the mesh's other repeaters.`,
    remoteCli: (p) => `set path.hash.mode ${p.mode}`,
  }),

  "set-loop-detect": define({
    name: "set-loop-detect",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      level: z.enum(["off", "minimal", "moderate", "strict"]).describe("loop-detection aggressiveness"),
    }),
    preview: (node, p) =>
      `Set ${node} loop-detect to ${p.level}. Drops flood packets whose path-hash already appears N times — anti-storm.`,
    remoteCli: (p) => `set loop.detect ${p.level}`,
  }),

  "set-flood-max": define({
    name: "set-flood-max",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      hops: coerce.numeric((s) => s.int().min(0).max(64), "max flood hop count, 0–64"),
    }),
    preview: (node, p) =>
      `Set ${node} flood hop-count limit to ${p.hops}. ⚠ Setting too low silently fragments the mesh.`,
    remoteCli: (p) => `set flood.max ${p.hops}`,
  }),

  "set-radio-rxgain": define({
    name: "set-radio-rxgain",
    tier: "config",
    scope: "remote-only",
    params: z.object({ enabled: z.boolean().describe("true to enable boosted RX gain") }),
    preview: (node, p) =>
      `Turn boosted RX gain ${p.enabled ? "on" : "off"} on ${node} (SX1262/SX1268 only — silently ignored on other radios).`,
    remoteCli: (p) => `set radio.rxgain ${p.enabled ? "on" : "off"}`,
  }),

  tempradio: define({
    name: "tempradio",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      freqMhz: coerce.freqMhz,
      bwKhz: coerce.bwKhz,
      sf: coerce.sf,
      cr: coerce.cr,
      timeoutMins: coerce.numeric((s) => s.int().min(1), "auto-revert timeout in minutes (≥1)"),
    }),
    preview: (node, p) =>
      `Apply radio params to ${node}: ${p.freqMhz} MHz / ${p.bwKhz} kHz / SF${p.sf} / CR${p.cr} for ${p.timeoutMins} min, then auto-revert. The safe radio-test escape hatch — recovers itself.`,
    remoteCli: (p) =>
      `tempradio ${p.freqMhz},${p.bwKhz},${p.sf},${p.cr},${p.timeoutMins}`,
  }),

  "set-tx-delay": define({
    name: "set-tx-delay",
    tier: "config",
    scope: "remote-only",
    params: z.object({ factor: coerce.numeric((s) => s.min(0).max(2), "TX delay factor 0–2") }),
    preview: (node, p) => `Set ${node} flood TX delay factor to ${p.factor}.`,
    remoteCli: (p) => `set txdelay ${p.factor}`,
  }),

  "set-direct-tx-delay": define({
    name: "set-direct-tx-delay",
    tier: "config",
    scope: "remote-only",
    params: z.object({ factor: coerce.numeric((s) => s.min(0).max(2), "direct TX delay factor 0–2") }),
    preview: (node, p) => `Set ${node} direct-traffic TX delay factor to ${p.factor}.`,
    remoteCli: (p) => `set direct.txdelay ${p.factor}`,
  }),

  "set-rx-delay": define({
    name: "set-rx-delay",
    tier: "config",
    scope: "remote-only",
    params: z.object({ secs: coerce.numeric((s) => s.min(0).max(20), "RX processing delay 0–20s") }),
    preview: (node, p) => `Set ${node} RX processing delay to ${p.secs}s (experimental).`,
    remoteCli: (p) => `set rxdelay ${p.secs}`,
  }),

  "set-airtime-factor": define({
    name: "set-airtime-factor",
    tier: "config",
    scope: "remote-only",
    params: z.object({ factor: coerce.numeric((s) => s.min(0).max(9), "airtime factor 0–9") }),
    preview: (node, p) =>
      `Set ${node} airtime factor to ${p.factor} (legacy; prefer set-dutycycle on firmware ≥1.15).`,
    remoteCli: (p) => `set af ${p.factor}`,
  }),

  "set-interference-threshold": define({
    name: "set-interference-threshold",
    tier: "config",
    scope: "remote-only",
    params: z.object({ value: coerce.numeric((s) => s, "interference threshold (firmware-defined units)") }),
    preview: (node, p) => `Set ${node} local interference threshold to ${p.value}.`,
    remoteCli: (p) => `set int.thresh ${p.value}`,
  }),

  "set-agc-reset-interval": define({
    name: "set-agc-reset-interval",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      secs: coerce.numeric(
        (s) => s.int().min(0),
        "AGC reset interval in seconds; firmware rounds to a multiple of 4 (0 disables)",
      ),
    }),
    preview: (node, p) =>
      `Set ${node} AGC reset interval to ${p.secs}s ${p.secs === 0 ? "(disabled)" : ""}.`,
    remoteCli: (p) => `set agc.reset.interval ${p.secs}`,
  }),

  "set-multi-acks": define({
    name: "set-multi-acks",
    tier: "config",
    scope: "remote-only",
    params: z.object({ enabled: z.boolean().describe("true to enable multi-ack support") }),
    preview: (node, p) => `Turn multi-ack support ${p.enabled ? "on" : "off"} on ${node}.`,
    remoteCli: (p) => `set multi.acks ${p.enabled ? 1 : 0}`,
  }),

  "set-flood-advert-interval": define({
    name: "set-flood-advert-interval",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      hours: coerce.numeric((s) => s.int().min(3).max(168), "flood-advert interval in hours, 3–168"),
    }),
    preview: (node, p) => `Set ${node} flood-advert interval to ${p.hours}h.`,
    remoteCli: (p) => `set flood.advert.interval ${p.hours}`,
  }),

  "set-advert-interval": define({
    name: "set-advert-interval",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      minutes: coerce.numeric(
        (s) => s.int().min(60).max(240),
        "zero-hop advert interval in minutes, 60–240; firmware stores it as /2 (use even values)",
      ),
    }),
    preview: (node, p) => `Set ${node} zero-hop advert interval to ${p.minutes}min.`,
    remoteCli: (p) => `set advert.interval ${p.minutes}`,
  }),

  "set-owner-info": define({
    name: "set-owner-info",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      text: z.string().max(140).describe("owner info shown in adverts; '|' in the string becomes a newline"),
    }),
    preview: (node, p) =>
      `Set ${node} owner info to "${p.text}" (\`|\` rendered as newline by the firmware).`,
    remoteCli: (p) => `set owner.info ${p.text}`,
  }),

  "set-adc-multiplier": define({
    name: "set-adc-multiplier",
    tier: "config",
    scope: "remote-only",
    params: z.object({
      value: coerce.numeric((s) => s.min(0).max(10), "ADC multiplier 0.0–10.0 (0 = board default)"),
    }),
    preview: (node, p) => `Set ${node} battery-ADC multiplier to ${p.value}.`,
    remoteCli: (p) => `set adc.multiplier ${p.value}`,
  }),

  "set-allow-read-only": define({
    name: "set-allow-read-only",
    tier: "sensitive",
    scope: "remote-only",
    params: z.object({ enabled: z.boolean().describe("true to enable read-only mode") }),
    preview: (node, p) =>
      `Turn ${node}'s read-only mode ${p.enabled ? "on" : "off"}.` +
      (p.enabled ? " ⚠ Blocks subsequent write ops from any client." : ""),
    remoteCli: (p) => `set allow.read.only ${p.enabled ? "on" : "off"}`,
  }),

  // ---------- secrets / identity ------------------------------------------

  "set-guest-password": define({
    name: "set-guest-password",
    tier: "sensitive",
    scope: "remote-only",
    secret: true,
    params: z.object({ password: z.string().max(15).describe("new guest password, ≤15 chars") }),
    preview: (node) =>
      `Change ${node}'s guest password (read-only tier). ⚠ Sent over the mesh as CliData and echoed in the reply; secret — must not be retained in the traffic buffer.`,
    remoteCli: (p) => `set guest.password ${p.password}`,
  }),

  "set-private-key": define({
    name: "set-private-key",
    tier: "destructive",
    scope: "remote-only",
    secret: true,
    params: z.object({
      hex: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, "expected a 32-byte hex private key (64 chars)")
        .describe("new private key as 64 hex chars (32 bytes)"),
    }),
    preview: (node) =>
      `Rotate ${node}'s private key (changes its public key + identity). ⚠ Destructive: all existing contacts lose their reference to ${node}; the node reboots.`,
    remoteCli: (p) => `set prv.key ${p.hex.toLowerCase()}`,
  }),

  // ---------- lifecycle ---------------------------------------------------

  "start-ota": define({
    name: "start-ota",
    tier: "sensitive",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) =>
      `Trigger an OTA firmware update on ${node} (uses its node_name to look up the image). ⚠ The node will reboot; if the image is wrong, recovery may need serial.`,
    remoteCli: () => "start ota",
  }),

  clkreboot: define({
    name: "clkreboot",
    tier: "destructive",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) =>
      `Reset ${node}'s RTC to its fixed epoch (2024-05-15) and reboot. ⚠ Loses time-sync until a clock-sync arrives.`,
    remoteCli: () => "clkreboot",
  }),

  "set-time": define({
    name: "set-time",
    tier: "benign",
    scope: "remote-only",
    params: z.object({
      epochSecs: coerce.numeric(
        (s) => s.int().min(0),
        "absolute time as epoch seconds (firmware rejects backwards clocks)",
      ),
    }),
    preview: (node, p) =>
      `Set ${node}'s RTC to epoch ${p.epochSecs} (firmware ERR: if backwards from its current clock).`,
    remoteCli: (p) => `time ${p.epochSecs}`,
  }),

  powersaving: define({
    name: "powersaving",
    tier: "config",
    scope: "remote-only",
    params: z.object({ enabled: z.boolean().describe("true to enable sleep-between-TX power saving") }),
    preview: (node, p) =>
      `Turn power-saving ${p.enabled ? "on" : "off"} on ${node} (repeater-only; sleeps between transmits).`,
    remoteCli: (p) => `powersaving ${p.enabled ? "on" : "off"}`,
  }),

  // ---------- reads ------------------------------------------------------
  // The reply field carries the device's structured text; agents should
  // parse it. These are tier "read" — the only commands in that tier.

  ver: define({
    name: "ver",
    tier: "read",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) => `Read ${node}'s firmware version + build date.`,
    remoteCli: () => "ver",
  }),

  board: define({
    name: "board",
    tier: "read",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) => `Read ${node}'s hardware board name.`,
    remoteCli: () => "board",
  }),

  clock: define({
    name: "clock",
    tier: "read",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) => `Read ${node}'s current device clock (HH:MM - D/M/Y UTC).`,
    remoteCli: () => "clock",
  }),

  neighbors: define({
    name: "neighbors",
    tier: "read",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) =>
      `List ${node}'s recent neighbours (up to 8) — each as \`{pk-prefix}:{ts}:{snr*4}\`. The H15 topology data source.`,
    remoteCli: () => "neighbors",
  }),

  "discover-neighbors": define({
    name: "discover-neighbors",
    tier: "benign",
    scope: "remote-only",
    params: NO_PARAMS,
    preview: (node) =>
      `Broadcast a node-discovery request from ${node}. Replies populate its neighbour list (read it back with \`neighbors\`).`,
    remoteCli: () => "discover.neighbors",
  }),

  "get-config": define({
    name: "get-config",
    tier: "read",
    scope: "remote-only",
    params: z.object({
      key: z
        .enum([
          // Settable keys (mirrors of set-* commands).
          "dutycycle",
          "af",
          "int.thresh",
          "agc.reset.interval",
          "multi.acks",
          "allow.read.only",
          "flood.advert.interval",
          "advert.interval",
          "guest.password",
          "name",
          "repeat",
          "radio.rxgain",
          "radio",
          "lat",
          "lon",
          "rxdelay",
          "txdelay",
          "flood.max",
          "direct.txdelay",
          "owner.info",
          "path.hash.mode",
          "loop.detect",
          "tx",
          "adc.multiplier",
          // Read-only.
          "public.key",
          "role",
          "freq",
        ])
        .describe(
          "config key to read; `prv.key` is intentionally excluded (firmware blocks remote read for security)",
        ),
    }),
    preview: (node, p) => `Read ${node}'s \`${p.key}\` config value.`,
    remoteCli: (p) => `get ${p.key}`,
  }),

  // ---------- subsystems -------------------------------------------------
  // region / gps / sensor are multi-subcommand verbs; one ADMIN entry each
  // with a discriminated-union param. Conditional-compile features (GPS,
  // sensor): the device returns an error string if the feature isn't built.

  region: define({
    name: "region",
    tier: "config",
    scope: "remote-only",
    params: z
      .discriminatedUnion("sub", [
        z.object({ sub: z.literal("status") }).describe("export the region map (up to 160 chars)"),
        z.object({ sub: z.literal("save") }).describe("persist regions to flash"),
        z
          .object({ sub: z.literal("allowf"), region: z.string() })
          .describe("clear DENY_FLOOD on a region (prefix-matched)"),
        z
          .object({ sub: z.literal("denyf"), region: z.string() })
          .describe("set DENY_FLOOD on a region (prefix-matched)"),
        z
          .object({ sub: z.literal("get"), region: z.string() })
          .describe("read a region's info (prefix-matched)"),
        z
          .object({ sub: z.literal("home-get") })
          .describe("read the home region"),
        z
          .object({ sub: z.literal("home-set"), region: z.string() })
          .describe("set the home region (auto-creates if needed)"),
        z
          .object({ sub: z.literal("default-get") })
          .describe("read the default region"),
        z
          .object({ sub: z.literal("default-set"), region: z.string() })
          .describe("set the default region (auto-creates if needed; use '<null>' to clear)"),
        z
          .object({ sub: z.literal("put"), name: z.string(), parent: z.string().optional() })
          .describe("create a region (optional parent; defaults to wildcard)"),
        z
          .object({ sub: z.literal("remove"), region: z.string() })
          .describe("remove an empty region (exact name match)"),
        z
          .object({ sub: z.enum(["list-allowed", "list-denied"]) })
          .describe("list regions by DENY_FLOOD state"),
      ])
      .describe(
        "region subcommand — `load` is multi-line interactive (serial-only) and not exposed",
      ),
    preview: (node, p) => {
      const r = "region" in p ? ` "${p.region}"` : "";
      return `Run region.${p.sub}${r} on ${node}.`;
    },
    remoteCli: (p) => {
      switch (p.sub) {
        case "status":
          return "region";
        case "save":
          return "region save";
        case "allowf":
          return `region allowf ${p.region}`;
        case "denyf":
          return `region denyf ${p.region}`;
        case "get":
          return `region get ${p.region}`;
        case "home-get":
          return "region home";
        case "home-set":
          return `region home set ${p.region}`;
        case "default-get":
          return "region default";
        case "default-set":
          return `region default set ${p.region}`;
        case "put":
          return p.parent === undefined
            ? `region put ${p.name}`
            : `region put ${p.name} ${p.parent}`;
        case "remove":
          return `region remove ${p.region}`;
        case "list-allowed":
          return "region list allowed";
        case "list-denied":
          return "region list denied";
      }
    },
  }),

  gps: define({
    name: "gps",
    tier: "config",
    scope: "remote-only",
    params: z
      .discriminatedUnion("sub", [
        z.object({ sub: z.literal("status") }).describe("read GPS state (on/off, fix, sat count)"),
        z.object({ sub: z.literal("on") }).describe("enable GPS"),
        z.object({ sub: z.literal("off") }).describe("disable GPS"),
        z.object({ sub: z.literal("sync") }).describe("sync device clock from GPS"),
        z.object({ sub: z.literal("setloc") }).describe("copy current GPS fix to node lat/lon prefs"),
        z.object({ sub: z.literal("advert-get") }).describe("read advert-location policy"),
        z
          .object({ sub: z.literal("advert-set"), policy: z.enum(["none", "share", "prefs"]) })
          .describe("set advert-location policy"),
      ])
      .describe(
        "GPS subcommand — requires firmware compiled with ENV_INCLUDE_GPS; returns an error string otherwise",
      ),
    preview: (node, p) => `Run gps.${p.sub} on ${node}.`,
    remoteCli: (p) => {
      switch (p.sub) {
        case "status":
          return "gps";
        case "on":
          return "gps on";
        case "off":
          return "gps off";
        case "sync":
          return "gps sync";
        case "setloc":
          return "gps setloc";
        case "advert-get":
          return "gps advert";
        case "advert-set":
          return `gps advert set ${p.policy}`;
      }
    },
  }),

  sensor: define({
    name: "sensor",
    tier: "config",
    scope: "remote-only",
    params: z
      .discriminatedUnion("sub", [
        z.object({ sub: z.literal("get"), key: z.string() }).describe("read a sensor setting"),
        z
          .object({ sub: z.literal("set"), key: z.string(), value: z.string() })
          .describe("set a custom sensor variable"),
        z
          .object({ sub: z.literal("list"), startIndex: z.number().int().min(0).optional() })
          .describe("list all sensor settings (paginated, 134-char chunks)"),
      ])
      .describe(
        "sensor subcommand — requires firmware compiled with sensor support; returns an error string otherwise",
      ),
    preview: (node, p) => `Run sensor.${p.sub} on ${node}.`,
    remoteCli: (p) => {
      switch (p.sub) {
        case "get":
          return `sensor get ${p.key}`;
        case "set":
          return `sensor set ${p.key} ${p.value}`;
        case "list":
          return p.startIndex === undefined ? "sensor list" : `sensor list ${p.startIndex}`;
      }
    },
  }),
});

/**
 * Every valid `command` name, in registry order — the enumerated command list.
 *
 * The `admin` tool deliberately validates its `command` arg with a bare
 * `z.string()`, **not** `z.enum(ADMIN_COMMAND_NAMES)`: the MCP SDK validates the
 * input schema *before* the tool handler runs, so a `z.enum` would reject an
 * unknown value with raw Zod JSON and bypass the friendly "Known commands: …"
 * message ({@link MeshService.runAdmin} throws an `AdminCommandError`, caught by
 * the tool — H8). So this list is the *source* of that known-command list (used
 * in the error message), not an input-schema enum.
 */
export const ADMIN_COMMAND_NAMES = Object.keys(ADMIN_COMMANDS) as [string, ...string[]];
