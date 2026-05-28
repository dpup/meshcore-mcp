/**
 * `get_recent_traffic` — drain the recent-traffic buffer, optionally windowed
 * by a `since` threshold (PRD §5.1).
 *
 * `since` accepts a **relative duration** (`"10m"`, `"1h"`), an ISO-8601
 * datetime, or an epoch-ms number, resolved to a millisecond threshold and
 * passed to {@link MeshService.recentTraffic}.
 *
 * **Prefer the relative form.** The buffer stamps events with the **injected
 * clock**, and a relative `since` is resolved against that same clock
 * (`now - X`), so it is correct under *any* clock — the portable form. The
 * absolute forms (ISO / epoch-ms) are wall-clock instants; they line up with
 * event stamps only when the clock *is* wall-clock (production `SystemClock`,
 * or the demo's `RealtimeClock`) — not under the virtual `SimClock` used in
 * tests, where an absolute `since` would be billions of ms past every event and
 * window out everything. "now"-relative logic uses the injected clock for
 * determinism — never `Date.now()`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toMillis } from "../clock.js";
import { digestRecentTraffic, recentTrafficOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

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
  registerServiceTool(server, service, {
    name: "get_recent_traffic",
    config: {
      title: "Get recent traffic",
      description:
        "Recent live mesh traffic from the rolling buffer, oldest→newest, each " +
        "tagged with structural provenance (kind + decrypt-verified). Optional " +
        '`since` windows it — prefer a relative duration ("10m", "1h", "30s"), ' +
        "which is the portable form; an ISO-8601 datetime or epoch-ms also work " +
        "but are wall-clock instants. Omit for all buffered traffic.",
      inputSchema: {
        since: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            'only newer events — prefer a relative duration ("10m", "1h", "30s"), the portable form; an ISO-8601 datetime or epoch-ms also work but are wall-clock instants; omit for all buffered',
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
    errorContext: () => ({ attempted: "reading recent traffic" }),
    handle: async (svc, { since }) => {
      const now = svc.now();
      const threshold = resolveSince(since, now);
      const events = svc.recentTraffic(threshold);
      return { text: digestRecentTraffic(events, now), structured: { events, count: events.length } };
    },
  });
}
