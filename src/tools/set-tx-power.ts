/**
 * `set_tx_power` — top-level wrapper around the `set-tx-power` admin command.
 * Sets a node's transmit power in dBm.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `set_tx_power`. */
export function registerSetTxPower(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "set_tx_power",
    commandName: "set-tx-power",
    title: "Set a node's transmit power",
    description:
      "Set the radio transmit power in dBm on a node. Omit `node` to target " +
      "home. Equivalent to `admin <node> set-tx-power { dbm }`. ⚠ Confirm " +
      "the value is legal for your band/region; some boards add a PA stage " +
      "on top of the configured dBm.",
  });
}
