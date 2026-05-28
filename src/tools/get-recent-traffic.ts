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

import { toMillis } from "../clock.js";
import { toolError } from "../errors.js";
import { digestRecentTraffic, recentTrafficOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/** A relative-duration `since` like `"10m"`, `"1h"`, `"30s"`, `"500ms"`. */
const DURATION = /^\d+(?:\.\d+)?\s*(?:ms|s|m|h)$/i;

/**
 * Resolve a `since` argument to a millisecond threshold compatible with the
 * injected-clock `at` stamps, relative to `nowMs`. Accepts:
 * - a **relative duration** (`"10m"`, `"1h"`) — "within the last X" ⇒ `now - X`;
 * - an **ISO-8601** datetime;
 * - an **epoch-ms** number (also the form sim tests pass).
 * An unparseable value throws so the tool surfaces it as an error result.
 */
export function resolveSince(since: string | number | undefined, nowMs: number): number | undefined {
  if (since === undefined) return undefined;
  if (typeof since === "number") {
    if (!Number.isFinite(since)) {
      throw new Error(`invalid \`since\`: ${since} (expected a finite epoch-ms number)`);
    }
    return since;
  }
  const trimmed = since.trim();
  if (DURATION.test(trimmed)) return nowMs - toMillis(trimmed);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `invalid \`since\`: "${since}" (expected a relative duration like "10m", an ISO-8601 datetime, or epoch-ms)`,
    );
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
        '`since` windows it: a relative duration ("10m", "1h"), an ISO-8601 ' +
        "datetime, or epoch-ms. Omit for all buffered traffic.",
      inputSchema: {
        since: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            'only newer events — a relative duration ("10m", "1h"), an ISO-8601 datetime, or epoch-ms; omit for all buffered',
          ),
      },
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
        const now = service.now();
        const threshold = resolveSince(since, now);
        const events = service.recentTraffic(threshold);
        return {
          content: [{ type: "text", text: digestRecentTraffic(events, now) }],
          structuredContent: { events, count: events.length },
        };
      } catch (error) {
        return toolError(error, { attempted: "reading recent traffic" });
      }
    },
  );
}
