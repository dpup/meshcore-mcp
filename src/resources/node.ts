import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resourceReadError } from "../errors.js";
import { nodeHealthOutput } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/**
 * Register the `meshcore://node/{node}` resource template — one node's health
 * snapshot by name or hex key prefix, with the `{node}` variable **autocompleting**
 * to live node/contact names (`completion/complete`). This is the
 * resource-template counterpart to `get_node_health`, and the MCP-supported way
 * to make node names discoverable/completable (tool arguments can't be completed).
 */
export function registerNode(server: McpServer, service: MeshService): void {
  server.registerResource(
    "node",
    new ResourceTemplate("meshcore://node/{node}", {
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
    {
      title: "Node health",
      description: "Health snapshot for one node, addressed by name or hex key prefix (the {node} variable autocompletes).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.node;
      const nodeArg = Array.isArray(raw) ? raw[0] : raw;
      const resolved = typeof nodeArg === "string" ? decodeURIComponent(nodeArg) : undefined;
      try {
        // The service returns raw intent (battery in millivolts only). Project
        // through the presentation layer so the resource emits the same battery
        // `volts`/`percent` (and overall shape) as the `get_node_health` tool.
        const health = nodeHealthOutput(await service.nodeHealth(resolved));
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(health, null, 2) }],
        };
      } catch (error) {
        resourceReadError(uri.href, error, `reading node "${resolved ?? "<home>"}"`);
      }
    },
  );
}
