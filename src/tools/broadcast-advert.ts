/**
 * `broadcast_advert` — top-level wrapper around the `advert` admin command.
 * Same dispatch as `admin <node> advert`; exposed top-level for its benign
 * tier annotations + per-command Zod input.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `broadcast_advert`. */
export function registerBroadcastAdvert(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "broadcast_advert",
    commandName: "advert",
    title: "Broadcast an advert",
    description:
      "Send an advert from a node — home or remote. `mode` selects between " +
      "`flood` (mesh-wide) and `zerohop` (immediate neighbours only). Omit " +
      "`node` to target home. Equivalent to `admin <node> advert { mode }`. " +
      "Costs airtime; flood propagates mesh-wide.",
  });
}
