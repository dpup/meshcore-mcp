/**
 * `get_recent_traffic` — drain the recent-traffic buffer, optionally windowed
 * by a `since` threshold (PRD §5.1).
 *
 * `since` accepts an ISO-8601 datetime **or** an epoch-ms number, resolved to a
 * millisecond threshold and passed to {@link MeshService.recentTraffic}. The
 * buffer stamps events with the **injected clock** (`SimClock` in tests,
 * `SystemClock` in prod), so in sim tests `since` is a virtual-ms number (e.g.
 * `5000` for "since +5s"), not a wall-clock instant. Any "now"-relative logic
 * uses the injected clock for determinism — never `Date.now()`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { digestRecentTraffic, recentTrafficOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/**
 * Resolve a `since` argument (ISO string or epoch-ms number) to a millisecond
 * threshold compatible with the injected-clock `at` stamps. A number passes
 * through; a string is parsed as ISO-8601. An unparseable string throws so the
 * tool surfaces it as an error result.
 */
export function resolveSince(since: string | number | undefined): number | undefined {
  if (since === undefined) return undefined;
  if (typeof since === "number") {
    if (!Number.isFinite(since)) {
      throw new Error(`invalid \`since\`: ${since} (expected a finite epoch-ms number)`);
    }
    return since;
  }
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid \`since\`: "${since}" (expected ISO-8601 or epoch-ms)`);
  }
  return parsed;
}

/** Register the `get_recent_traffic` read tool on `server`, backed by `service`. */
export function registerGetRecentTraffic(server: McpServer, service: MeshService): void {
  server.registerTool(
    "get_recent_traffic",
    {
      title: "Get recent traffic",
      description:
        "Recent live mesh traffic from the rolling buffer, oldest→newest, each " +
        "tagged with structural provenance (kind + decrypt-verified). Optional " +
        "`since` (ISO-8601 datetime or epoch-ms) windows to events at/after that " +
        "time. In sim tests `since` is a virtual-clock ms number.",
      inputSchema: { since: z.union([z.string(), z.number()]).optional() },
      outputSchema: recentTrafficOutputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ since }) => {
      try {
        const threshold = resolveSince(since);
        const events = service.recentTraffic(threshold);
        return {
          content: [{ type: "text", text: digestRecentTraffic(events) }],
          structuredContent: { events, count: events.length },
        };
      } catch (error) {
        return toolError(error, { attempted: "reading recent traffic" });
      }
    },
  );
}
