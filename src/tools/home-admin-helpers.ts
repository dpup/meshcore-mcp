/**
 * The "unwrapped" admin tools — top-level MCP tools for selected
 * ADMIN_COMMANDS entries (currently 13: 7 home+remote + 6 remote-only
 * reads). Each tool delegates to the corresponding registry entry via
 * {@link MeshService.runAdmin}, so:
 *
 * - **per-command MCP annotations work** — `set_tx_power` carries
 *   `idempotentHint: true, destructiveHint: false`, `reboot_node` carries
 *   `destructiveHint: true, idempotentHint: false`, etc. The multiplexed
 *   `admin` tool can only carry conservative static annotations because one
 *   tool can't express per-command hints (AGENTS.md don't-regress #4);
 *   these wrappers fix that for the unwrapped subset.
 * - **per-command input schemas** are validated by the SDK before the
 *   handler runs (the multiplexed `admin` tool's `params` is `z.record` /
 *   opaque, re-parsed inside `runAdmin`).
 *
 * Two scope flavours both wrap cleanly here:
 * - **home+remote** — `node` is optional (omit ⇒ home), e.g. `reboot_node`.
 *   Requires the underlying `ADMIN_COMMANDS` entry to expose a `home()`
 *   path; the registration guard enforces this at server startup.
 * - **remote-only** — `node` is required (no home path), e.g.
 *   `get_node_neighbors` (the CLI's `neighbors` verb only exists on
 *   repeater firmware, so against home it would return the same
 *   role-mismatch error the `admin` tool returns).
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

/**
 * Compile-time exhaustiveness check. Used at the `default` branch of a
 * switch over a string-literal union so a future addition to the union
 * fails compilation here, forcing the new case to be handled rather than
 * silently falling into the default branch.
 */
function assertNever(x: never): never {
  throw new Error(`unhandled discriminant: ${JSON.stringify(x)}`);
}

/**
 * The repeating cross-reference in remote-only tool descriptions
 * ("For the home node, use `get_node_health()` (the `X` field)") —
 * extracted so renaming a `get_node_health` field is a one-line change
 * here, not 4+ description edits.
 */
function homeAlternative(healthField: string): string {
  return (
    `For the home node, use \`get_node_health()\` (the \`${healthField}\` field) — ` +
    `that's the structured equivalent via the companion protocol, no admin call needed.`
  );
}

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
 * The unwrapped admin tools. Single source of truth: {@link
 * registerUnwrappedAdminTools} iterates this list to register, and
 * `instructions.ts` derives the tool-name surface mentioned in
 * `SERVER_INSTRUCTIONS` from the same list.
 *
 * Adding another is one entry here — no new file, no separate
 * registration line, no instructions-list edit. The entry must reference
 * a valid `ADMIN_COMMANDS` key; `home+remote` commands must additionally
 * expose a `home()` path. The registration guard enforces both at
 * server startup so a bad entry fails loud during dev, not as a runtime
 * dispatch mismatch later.
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

  // -------- remote-only reads + benign diagnostics --------
  // These wrap repeater-firmware CLI verbs that don't exist on companion
  // firmware. They're unwrapped here for the per-command MCP annotations
  // (readOnlyHint: true for reads) and discoverability. `node` is required
  // — there's no home path. For most of these, the analogous companion-
  // protocol read is already in `get_node_health` (firmware version,
  // location, etc.), so for the *home* node use that instead.

  {
    name: "get_node_version",
    commandName: "ver",
    title: "Read a remote node's firmware version",
    description:
      "Read a remote repeater's firmware version + build date string. " +
      "Equivalent to `admin <node> ver`. Required `node` — only repeater " +
      "firmware implements the `ver` CLI verb. " +
      homeAlternative("firmware"),
  },
  {
    name: "get_node_board",
    commandName: "board",
    title: "Read a remote node's hardware board",
    description:
      "Read a remote repeater's hardware board / model identifier. " +
      "Equivalent to `admin <node> board`. Required `node`. " +
      homeAlternative("firmware.manufacturerModel"),
  },
  {
    name: "get_node_clock",
    commandName: "clock",
    title: "Read a remote node's current clock",
    description:
      "Read a remote repeater's current device clock (HH:MM - D/M/Y UTC). " +
      "Equivalent to `admin <node> clock`. Required `node`. " +
      homeAlternative("deviceTimeMs"),
  },
  {
    name: "get_node_neighbors",
    commandName: "neighbors",
    title: "Read a remote node's recent neighbours",
    description:
      "List a remote repeater's recent neighbours (up to 8), each as " +
      "`{pk-prefix}:{ts}:{snr*4}` in the reply text. The H15 topology " +
      "data source. Equivalent to `admin <node> neighbors`. Required " +
      "`node`. Pairs with `discover_neighbors(node)` to trigger an " +
      "active probe first.",
  },
  {
    name: "discover_neighbors",
    commandName: "discover-neighbors",
    title: "Trigger a node's neighbour discovery",
    description:
      "Broadcast a node-discovery request from a remote repeater. Replies " +
      "populate its neighbour list — read it back with " +
      "`get_node_neighbors(node)`. Equivalent to `admin <node> " +
      "discover-neighbors`. Required `node`.",
  },
  {
    name: "get_node_config",
    commandName: "get-config",
    title: "Read a remote node's config value",
    description:
      "Read one of a remote repeater's configuration values by key (e.g. " +
      "`tx`, `radio`, `name`, `freq`, `flood.max`, `path.hash.mode`). " +
      "Equivalent to `admin <node> get-config { key }`. Required `node`. " +
      "The reply is a single line of text the agent parses. " +
      "For the home node's radio / identity config, use `get_node_health()` " +
      "(structured fields cover the common ones — `radio`, `firmware`, " +
      "`location`, `autoAddContacts`).",
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
 * Register one entry. Validates the command exists, has a ZodObject
 * params schema, and doesn't collide with the helper's tool-level keys.
 * Throws at startup on any violation so a bad shape surfaces in dev,
 * not as a runtime tool-shape mismatch later. Whether `node` is required
 * (remote-only) or optional (home+remote) is derived from `def.scope`.
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
  // Restored from v0.1.5: a `home+remote` command without a `home()` path
  // would register fine here but throw the role-mismatch error at
  // runtime — surface that gap at startup instead. Today every
  // `home+remote` entry in ADMIN_COMMANDS has a `home()` path; this
  // catches a future addition that forgets to add one.
  if (def.scope === "home+remote" && def.home === undefined) {
    throw new Error(
      `registerUnwrappedAdminTools: "${spec.commandName}" is scope=home+remote ` +
        `but has no home() path; the unwrap would dispatch successfully ` +
        `against a remote node but throw a role-mismatch at runtime when ` +
        `targeted at home. Add a home() path to ADMIN_COMMANDS["${spec.commandName}"] ` +
        `or remove the entry from UNWRAPPED_ADMIN_TOOLS.`,
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

  // home+remote → `node` optional (omit ⇒ home). remote-only → required
  // (no home path; the SDK should reject before the handler runs rather
  // than letting runAdmin's role-mismatch error surface).
  //
  // Switch (not ternary) so adding a third scope value to AdminScope is a
  // compile-time error here — the `never` exhaustiveness check forces a
  // conscious decision about whether `node` is optional or required for
  // the new scope.
  const nodeSchema = (() => {
    const base = z.string().min(1);
    switch (def.scope) {
      case "home+remote":
        return base
          .describe(
            "target node (contact name or hex public-key prefix); omit to target the home node",
          )
          .optional();
      case "remote-only":
        return base.describe(
          "target node (contact name or hex public-key prefix); required (this command isn't implemented on companion firmware so it can't target home)",
        );
      default:
        // Compile-time exhaustiveness check: a new AdminScope value lands here.
        return assertNever(def.scope);
    }
  })();

  registerServiceTool(server, service, {
    name: spec.name,
    config: {
      title: spec.title,
      description: spec.description,
      // Command params first, tool-level keys after — so even if the
      // collision guard above is ever loosened, `node` / `dryRun`
      // deterministically come from the tool layer.
      inputSchema: {
        ...commandShape,
        node: nodeSchema,
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
