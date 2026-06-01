/**
 * `set_node_location` — top-level wrapper around the `set-location` admin
 * command. Sets a node's advertised lat/lon.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `set_node_location`. */
export function registerSetNodeLocation(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "set_node_location",
    commandName: "set-location",
    title: "Set a node's advertised location",
    description:
      "Set a node's advertised lat/lon (decimal degrees). Omit `node` to " +
      "target home. Equivalent to `admin <node> set-location { lat, lon }`.",
  });
}
