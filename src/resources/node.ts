import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";

import { nodeHealthOutput } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerJsonResource } from "./register.js";

/**
 * Resolve the `{node}` template variable to the node argument: the SDK hands it
 * raw (and possibly as an array), so take the first value and URL-decode it.
 * `undefined` means the home node.
 */
function resolveNode(variables: Variables): string | undefined {
  const raw = variables.node;
  const nodeArg = Array.isArray(raw) ? raw[0] : raw;
  return typeof nodeArg === "string" ? decodeURIComponent(nodeArg) : undefined;
}

/**
 * Register the `meshcore://node/{node}` resource template — one node's health
 * snapshot by name or hex key prefix, with the `{node}` variable **autocompleting**
 * to live node/contact names (`completion/complete`). This is the
 * resource-template counterpart to `get_node_health`, and the MCP-supported way
 * to make node names discoverable/completable (tool arguments can't be completed).
 */
export function registerNode(server: McpServer, service: MeshService): void {
  registerJsonResource(server, {
    name: "node",
    uri: new ResourceTemplate("meshcore://node/{node}", {
      // We don't enumerate node URIs (the roster lives at meshcore://nodes), but
      // the variable autocompletes.
      list: undefined,
      complete: {
        node: async (value) => {
          const names = await service.nodeNames();
          const v = value.toLowerCase();
          return names.filter((n) => n.toLowerCase().includes(v));
        },
      },
    }),
    metadata: {
      title: "Node health",
      description: "Health snapshot for one node, addressed by name or hex key prefix (the {node} variable autocompletes).",
      mimeType: "application/json",
    },
    attempted: (_uri, variables) => `reading node "${resolveNode(variables) ?? "<home>"}"`,
    // The service returns raw intent (battery in millivolts only). Project
    // through the presentation layer so the resource emits the same battery
    // `volts`/`percent` (and overall shape) as the `get_node_health` tool.
    load: async (_uri, variables) => nodeHealthOutput(await service.nodeHealth(resolveNode(variables))),
  });
}
