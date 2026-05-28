import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestTrace, tracePathOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/**
 * `trace_path` — trace a route through the mesh and report each hop's SNR. Send
 * a trace packet along an explicit `path` of repeater hops, or along a contact's
 * known out-path (`node`), and get back the hops + per-hop signal — a precise
 * propagation/coverage probe ("how many repeaters relay to X, and how strong").
 *
 * A trace transmits a probe; it's a diagnostic action, not a read. A path that
 * doesn't respond surfaces as an actionable timeout, not a hang.
 */
export function registerTracePath(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "trace_path",
    config: {
      title: "Trace a mesh path",
      description:
        "Trace a route through the mesh and report each repeater hop's SNR. Give " +
        "an explicit `path` of repeater hops (comma-separated hex bytes, e.g. " +
        '"23,5f,3a") or a `node` (a contact name / hex prefix) to trace along its ' +
        "known out-path. A path that doesn't respond returns a timeout.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('repeater hops as comma-separated hex bytes, e.g. "23,5f,3a" (or a hex string)'),
        node: z
          .string()
          .optional()
          .describe("a contact (name or hex prefix) to trace along its known out-path"),
      },
      outputSchema: tracePathOutputShape,
      // Transmits a trace probe — not read-only; each trace is a fresh packet
      // (not idempotent); benign (not destructive).
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    errorContext: () => ({ attempted: "tracing the path" }),
    handle: async (svc, { path, node }) => {
      const result = await svc.tracePath({ path, node });
      return { text: digestTrace(result), structured: result };
    },
  });
}
