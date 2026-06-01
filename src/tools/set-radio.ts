/**
 * `set_radio` — top-level wrapper around the `set-radio` admin command.
 * Sets a node's full radio parameter set (freq, bandwidth, SF, CR).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerHomeAdminTool } from "./home-admin-helpers.js";

/** Register `set_radio`. */
export function registerSetRadio(server: McpServer, service: MeshService): void {
  registerHomeAdminTool(server, service, {
    name: "set_radio",
    commandName: "set-radio",
    title: "Set a node's radio parameters",
    description:
      "Set frequency (MHz), bandwidth (kHz), spreading factor, and coding " +
      "rate on a node. Omit `node` to target home. Equivalent to " +
      "`admin <node> set-radio { freqMhz, bwKhz, sf, cr }`. ⚠ Applies after " +
      "a reboot; if the new params no longer match the rest of the mesh, " +
      "the node drops off the network.",
  });
}
