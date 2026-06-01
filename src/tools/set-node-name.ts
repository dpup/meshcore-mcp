/**
 * `set_node_name` — top-level wrapper around the `set-name` admin command.
 * Sets a node's advertised name.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `set_node_name`. */
export function registerSetNodeName(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "set_node_name",
    commandName: "set-name",
    title: "Set a node's advertised name",
    description:
      "Rename a node's advertised mesh name. Omit `node` to target home. " +
      "Equivalent to `admin <node> set-name { name }`. Max 32 bytes (24 if " +
      "a location is set).",
  });
}
