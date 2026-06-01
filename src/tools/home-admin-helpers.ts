/**
 * The 0.1.5 "unwrapped" admin tools — top-level MCP tools for the 7
 * ADMIN_COMMANDS entries that have a structured (companion-protocol) home
 * path. Each tool delegates to the corresponding registry entry via
 * {@link MeshService.runAdmin}, so:
 *
 * - **per-command MCP annotations work** — `set_tx_power` carries
 *   `idempotentHint: true, destructiveHint: false`, `reboot_node` carries
 *   `destructiveHint: true, idempotentHint: false`, etc. The multiplexed
 *   `admin` tool can only carry conservative static annotations because one
 *   tool can't express per-command hints (AGENTS.md don't-regress #4);
 *   these wrappers fix that for the 7 most-used commands.
 * - **per-command input schemas** are validated by the SDK before the
 *   handler runs (the multiplexed `admin` tool's `params` is `z.record` /
 *   opaque, re-parsed inside `runAdmin`).
 *
 * The `admin` sub-command path stays intact (back-compat) — both
 * `admin <node> reboot` and `reboot_node { node }` reach the same
 * `runAdmin` dispatch with identical behaviour.
 *
 * The registry below is the single source of truth: `server.ts` registers
 * everything in one loop via {@link registerUnwrappedAdminTools}, and
 * `instructions.ts` derives its surface list from the same registry —
 * there's no parallel hand-maintained list of names.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { adminOutputShape, digestAdmin } from "../format.js";
import { ADMIN_COMMANDS, annotationsForTier } from "../service/admin.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** One entry in the {@link UNWRAPPED_ADMIN_TOOLS} registry. */
export interface UnwrappedAdminTool {
  /** The MCP tool name (e.g. `"reboot_node"`). */
  name: string;
  /** The matching key into {@link ADMIN_COMMANDS} (e.g. `"reboot"`). */
  commandName: string;
  /** The tool's human title (shown in tool list UIs). */
  title: string;
  /** The tool's agent-facing description. */
  description: string;
}

/**
 * The 7 unwrapped admin tools. Single source of truth: {@link
 * registerUnwrappedAdminTools} iterates this list to register, and
 * `instructions.ts` derives the tool-name surface mentioned in
 * `SERVER_INSTRUCTIONS` from the same list.
 *
 * Adding an 8th is one entry here — no new file, no separate registration
 * line, no instructions-list edit. The entry must reference an
 * `ADMIN_COMMANDS` key whose scope is `"home+remote"` (a structured `home`
 * path exists); the registration guard enforces this at server startup.
 */
export const UNWRAPPED_ADMIN_TOOLS: readonly UnwrappedAdminTool[] = [
  {
    name: "reboot_node",
    commandName: "reboot",
    title: "Reboot a node",
    description:
      "Reboot a node — the home companion or a remote repeater. Omit `node` " +
      "to target home. Equivalent to `admin <node> reboot`; this top-level " +
      "form carries the destructive-tier annotations directly. ⚠ The node " +
      "is unreachable for ~30–60s while it restarts; any session ends.",
  },
  {
    name: "broadcast_advert",
    commandName: "advert",
    title: "Broadcast an advert",
    description:
      "Send an advert from a node — home or remote. `mode` selects between " +
      "`flood` (mesh-wide) and `zerohop` (immediate neighbours only). Omit " +
      "`node` to target home. Equivalent to `admin <node> advert { mode }`. " +
      "Costs airtime; flood propagates mesh-wide.",
  },
  {
    name: "sync_clock",
    commandName: "sync-time",
    title: "Sync a node's clock",
    description:
      "Set a node's clock to the controller's current time. Omit `node` to " +
      "target home. Equivalent to `admin <node> sync-time`. No-op if already " +
      "in sync. For an explicit epoch on a remote repeater, use " +
      "`admin <node> set-time { epochSecs }` instead.",
  },
  {
    name: "set_tx_power",
    commandName: "set-tx-power",
    title: "Set a node's transmit power",
    description:
      "Set the radio transmit power in dBm on a node. Omit `node` to target " +
      "home. Equivalent to `admin <node> set-tx-power { dbm }`. ⚠ Confirm " +
      "the value is legal for your band/region; some boards add a PA stage " +
      "on top of the configured dBm.",
  },
  {
    name: "set_radio",
    commandName: "set-radio",
    title: "Set a node's radio parameters",
    description:
      "Set frequency (MHz), bandwidth (kHz), spreading factor, and coding " +
      "rate on a node. Omit `node` to target home. Equivalent to " +
      "`admin <node> set-radio { freqMhz, bwKhz, sf, cr }`. ⚠ Applies after " +
      "a reboot; if the new params no longer match the rest of the mesh, " +
      "the node drops off the network.",
  },
  {
    name: "set_node_name",
    commandName: "set-name",
    title: "Set a node's advertised name",
    description:
      "Rename a node's advertised mesh name. Omit `node` to target home. " +
      "Equivalent to `admin <node> set-name { name }`. Max 32 bytes (24 if " +
      "a location is set).",
  },
  {
    name: "set_node_location",
    commandName: "set-location",
    title: "Set a node's advertised location",
    description:
      "Set a node's advertised lat/lon (decimal degrees). Omit `node` to " +
      "target home. Equivalent to `admin <node> set-location { lat, lon }`.",
  },
];

/**
 * Register every entry in {@link UNWRAPPED_ADMIN_TOOLS}. Replaces the
 * per-tool registrar files an earlier iteration used — one entry in the
 * registry above is now all that's needed to add a new unwrapped tool.
 */
export function registerUnwrappedAdminTools(
  server: McpServer,
  service: MeshService,
): void {
  for (const spec of UNWRAPPED_ADMIN_TOOLS) {
    registerOne(server, service, spec);
  }
}

/**
 * Register one entry. Validates the command exists, is home-reachable, has
 * a ZodObject params schema, and doesn't collide with the helper's
 * tool-level keys; throws at startup on any violation so the bad shape
 * surfaces in dev, not as a runtime tool-shape mismatch later.
 */
function registerOne(
  server: McpServer,
  service: MeshService,
  spec: UnwrappedAdminTool,
): void {
  const def = ADMIN_COMMANDS[spec.commandName];
  if (def === undefined) {
    throw new Error(`registerUnwrappedAdminTools: unknown command "${spec.commandName}"`);
  }
  if (def.scope !== "home+remote" || def.home === undefined) {
    throw new Error(
      `registerUnwrappedAdminTools: "${spec.commandName}" isn't home-reachable ` +
        `(scope=${def.scope}); only home+remote commands belong here.`,
    );
  }
  if (!(def.params instanceof z.ZodObject)) {
    throw new Error(
      `registerUnwrappedAdminTools: "${spec.commandName}" params must be a ` +
        `ZodObject (splicing its shape into the tool input).`,
    );
  }
  const commandShape = def.params.shape as Record<string, z.ZodTypeAny>;
  for (const k of ["node", "dryRun"]) {
    if (k in commandShape) {
      throw new Error(
        `registerUnwrappedAdminTools: "${spec.commandName}" params collide ` +
          `with tool-level key "${k}"; rename the command's param or extend ` +
          `the helper to disambiguate.`,
      );
    }
  }

  registerServiceTool(server, service, {
    name: spec.name,
    config: {
      title: spec.title,
      description: spec.description,
      // Command params first, tool-level keys after — so even if the
      // collision guard above is ever loosened, `node` / `dryRun`
      // deterministically come from the tool layer. `min(1)` on node
      // rejects an empty string at the schema (nullish coalescing only
      // catches null/undefined; `""` would otherwise reach `isHome("")`
      // → false → wrong remote dispatch).
      inputSchema: {
        ...commandShape,
        node: z
          .string()
          .min(1)
          .optional()
          .describe(
            "target node (contact name or hex public-key prefix); omit to target the home node",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("preview the intent without contacting the device"),
      },
      outputSchema: adminOutputShape,
      annotations: {
        // Per-command annotations from the tier — the whole point of
        // unwrapping. openWorldHint stays true (touches the mesh).
        ...annotationsForTier(def.tier),
        openWorldHint: true,
      },
    },
    errorContext: (args) => {
      const node = (args as { node?: string }).node;
      return { node: node ?? "home", attempted: `running ${spec.name}` };
    },
    handle: async (svc, args) => {
      const { node, dryRun, ...params } = args as {
        node?: string;
        dryRun?: boolean;
        [k: string]: unknown;
      };
      const result = await svc.runAdmin(node, spec.commandName, params, dryRun ?? false);
      return { text: digestAdmin(node ?? "home", result), structured: result };
    },
  });
}
