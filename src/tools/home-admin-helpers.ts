/**
 * Helper for the 0.1.5 "unwrapped" admin tools — `reboot_node`,
 * `broadcast_advert`, `sync_clock`, `set_tx_power`, `set_radio`,
 * `set_node_name`, `set_node_location`. Each is a top-level MCP tool that
 * delegates to the corresponding entry in {@link ADMIN_COMMANDS} via
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
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { adminOutputShape, digestAdmin } from "../format.js";
import { ADMIN_COMMANDS, annotationsForTier } from "../service/admin.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Options for {@link registerHomeAdminTool}. */
export interface HomeAdminToolOptions {
  /** The MCP tool name (e.g. `"reboot_node"`). */
  name: string;
  /** The matching key into {@link ADMIN_COMMANDS} (e.g. `"reboot"`). */
  commandName: string;
  /** The tool's human title (shown in tool list UIs). */
  title: string;
  /** The tool's agent-facing description. Should mention the admin equivalent. */
  description: string;
}

/**
 * Register one unwrapped admin tool. Looks the command up in
 * {@link ADMIN_COMMANDS}, splices the command's Zod params into the tool's
 * input schema alongside `node?` + `dryRun?`, derives per-command
 * annotations from {@link annotationsForTier}, and dispatches via
 * {@link MeshService.runAdmin}.
 */
export function registerHomeAdminTool(
  server: McpServer,
  service: MeshService,
  opts: HomeAdminToolOptions,
): void {
  const def = ADMIN_COMMANDS[opts.commandName];
  if (def === undefined) {
    throw new Error(`registerHomeAdminTool: unknown command "${opts.commandName}"`);
  }
  if (def.scope !== "home+remote" || def.home === undefined) {
    throw new Error(
      `registerHomeAdminTool: "${opts.commandName}" isn't home-reachable ` +
        `(scope=${def.scope}); only home+remote commands belong here.`,
    );
  }
  if (!(def.params instanceof z.ZodObject)) {
    throw new Error(
      `registerHomeAdminTool: "${opts.commandName}" params must be a ZodObject ` +
        `(splicing its shape into the tool input).`,
    );
  }
  const commandShape = def.params.shape as Record<string, z.ZodTypeAny>;

  registerServiceTool(server, service, {
    name: opts.name,
    config: {
      title: opts.title,
      description: opts.description,
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe(
            "target node (contact name or hex public-key prefix); omit to target the home node",
          ),
        ...commandShape,
        dryRun: z
          .boolean()
          .optional()
          .describe("preview the intent without contacting the device"),
      },
      outputSchema: adminOutputShape,
      annotations: {
        // Per-command annotations from the tier — the whole point of
        // unwrapping. openWorldHint stays true (the command touches the mesh).
        ...annotationsForTier(def.tier),
        openWorldHint: true,
      },
    },
    errorContext: (args) => {
      const node = (args as { node?: string }).node;
      return { node: node ?? "home", attempted: `running ${opts.name}` };
    },
    handle: async (svc, args) => {
      const { node, dryRun, ...params } = args as {
        node?: string;
        dryRun?: boolean;
        [k: string]: unknown;
      };
      const result = await svc.runAdmin(node, opts.commandName, params, dryRun ?? false);
      return { text: digestAdmin(node ?? "home", result), structured: result };
    },
  });
}
