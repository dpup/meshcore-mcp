/**
 * `sync_clock` — top-level wrapper around the `sync-time` admin command.
 * Sets a node's clock to the controller's current time.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `sync_clock`. */
export function registerSyncClock(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "sync_clock",
    commandName: "sync-time",
    title: "Sync a node's clock",
    description:
      "Set a node's clock to the controller's current time. Omit `node` to " +
      "target home. Equivalent to `admin <node> sync-time`. No-op if already " +
      "in sync. For an explicit epoch on a remote repeater, use " +
      "`admin <node> set-time { epochSecs }` instead.",
  });
}
