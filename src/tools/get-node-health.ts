/**
 * `get_node_health` — a consolidated health snapshot for one node.
 *
 * Hides the home-vs-remote distinction and the remote login behind a single
 * call (PRD §4): with no `node` it reports the connected home device; with a
 * name or hex pubkey prefix it reaches a remote repeater. An unreachable target
 * yields an actionable `isError` result, never a thrown exception (§5.3).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { digestNodeHealth, nodeHealthOutput, nodeHealthOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/** Register the `get_node_health` read tool on `server`, backed by `service`. */
export function registerGetNodeHealth(server: McpServer, service: MeshService): void {
  server.registerTool(
    "get_node_health",
    {
      title: "Get node health",
      description:
        "Consolidated health snapshot for a node: identity, radio, battery, " +
        "uptime/queue, and packet/radio stats. Omit `node` for the connected " +
        "home node; pass a contact name or hex public-key prefix for a remote " +
        "repeater (logs in and reads its status).",
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe(
            "a contact name or hex public-key prefix for a remote node; omit for the connected home node",
          ),
      },
      outputSchema: nodeHealthOutputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ node }) => {
      try {
        const health = await service.nodeHealth(node);
        // The service returns raw intent (battery in millivolts only). The
        // presentation projection adds the interpretive battery `volts`/`percent`
        // the wire schema carries; the digest renders the same projected data.
        const output = nodeHealthOutput(health);
        return {
          content: [{ type: "text", text: digestNodeHealth(output) }],
          // The SDK types `structuredContent` as a `Record<string, unknown>`
          // and validates it against `outputSchema` at runtime; widen the typed
          // result to that record shape (the schema is the real guarantee).
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return toolError(error, {
          node: node ?? "home node",
          attempted: "reading node health",
        });
      }
    },
  );
}
