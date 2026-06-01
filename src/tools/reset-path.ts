/**
 * `reset_path` — clear the cached forwarding path to a contact so the next
 * direct send re-discovers the route. Useful when a known path has gone
 * stale (a repeater rebooted, mesh topology changed).
 *
 * Companion-protocol operation; local-only state change.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestResetPath, resetPathOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `reset_path` tool on `server`, backed by `service`. */
export function registerResetPath(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "reset_path",
    config: {
      title: "Reset cached path to a contact",
      description:
        "Clear the local cached forwarding path to a contact. The next direct " +
        "send to that contact re-discovers the route. Useful when a known path " +
        "has gone stale (a repeater rebooted, topology changed) and direct " +
        "sends are failing or taking longer than expected.",
      inputSchema: {
        target: z.string().describe("contact name or hex public-key prefix"),
      },
      outputSchema: resetPathOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    errorContext: ({ target }) => ({ node: target, attempted: "resetting the contact path" }),
    handle: async (svc, { target }) => {
      const result = await svc.resetContactPath(target);
      return { text: digestResetPath(result), structured: result };
    },
  });
}
