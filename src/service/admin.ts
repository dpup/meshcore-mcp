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
 * One enumerated admin command. The `admin` tool validates its `command`
 * argument against the registry's keys and derives annotations from `tier`;
 * adding a command is one new {@link AdminCommandDef} entry (execution plan §9
 * "Adding a command is one new entry").
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
 * Keyed by `command` name; the `admin` tool's `command` enum is its keys.
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
    params: z.object({ mode: z.enum(["flood", "zerohop"]).default("flood") }),
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
      `Set ${node}'s clock to the controller's time (${new Date().toISOString()}). No-op if already in sync.`,
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
      name: z.string().refine((n) => Buffer.byteLength(n, "utf8") <= 32, {
        message: "name must be at most 32 bytes",
      }),
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
    params: z.object({ lat: z.number(), lon: z.number() }),
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
    params: z.object({ password: z.string().max(15) }),
    preview: (node) =>
      `Change ${node}'s admin password. ⚠ Sent over the mesh as CliData and echoed in the reply; ` +
      `mis-setting can lock out admins. Secret — must not be retained in the traffic buffer.`,
    remoteCli: (p) => `password ${p.password}`,
  }),

  "set-repeat": define({
    name: "set-repeat",
    tier: "config",
    scope: "remote-only",
    params: z.object({ enabled: z.boolean() }),
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
    params: z.object({ pubKeyPrefix: z.string().regex(/^[0-9a-fA-F]+$/, "expected a hex prefix") }),
    preview: (node, p) =>
      `Remove neighbour(s) matching prefix ${p.pubKeyPrefix} from ${node}'s list.`,
    remoteCli: (p) => `neighbor.remove ${p.pubKeyPrefix.toLowerCase()}`,
  }),

  "set-permission": define({
    name: "set-permission",
    tier: "sensitive",
    scope: "remote-only",
    params: z.object({
      pubKey: z.string().regex(/^[0-9a-fA-F]+$/, "expected a hex public key"),
      level: z.enum(PERMISSION_LEVELS).nullable(),
    }),
    preview: (node, p) =>
      `Set ${p.pubKey}'s permission on ${node} to ${p.level ?? "remove"} (or remove). ` +
      `⚠ 'admin' grants full control of ${node}.`,
    // `setperm <pubkey> <0–3>`; omit the level ⇒ remove the entry.
    remoteCli: (p) => {
      const key = p.pubKey.toLowerCase();
      return p.level === null
        ? `setperm ${key}`
        : `setperm ${key} ${PERMISSION_LEVEL_VALUE[p.level]}`;
    },
  }),
});

/** Every valid `command` name — the `admin` tool's `command` enum source. */
export const ADMIN_COMMAND_NAMES = Object.keys(ADMIN_COMMANDS) as [string, ...string[]];
