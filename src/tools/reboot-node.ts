/**
 * `reboot_node` — top-level wrapper around the `reboot` admin command. Same
 * dispatch as `admin <node> reboot`; this surface exists so the destructive
 * tier shows in MCP annotations directly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `reboot_node`. */
export function registerRebootNode(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "reboot_node",
    commandName: "reboot",
    title: "Reboot a node",
    description:
      "Reboot a node — the home companion or a remote repeater. Omit `node` " +
      "to target home. Equivalent to `admin <node> reboot`; this top-level " +
      "form carries the destructive-tier annotations directly. ⚠ The node " +
      "is unreachable for ~30–60s while it restarts; any session ends.",
  });
}
