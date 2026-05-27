/**
 * `meshcore://traffic/live` — the subscribable live-traffic resource (PRD §5.2,
 * execution plan §1, M4).
 *
 * A **read** returns the recent {@link TrafficEvent}s from
 * {@link MeshService.recentTraffic} as JSON, each carrying its full structural
 * **provenance**: server id, injected-clock `at`, `kind`, `decryptVerified`,
 * sender, `channelIdx`, `rssi`/`snr`, and decoded `text` (verified messages
 * only). The verified-vs-unverified distinction is preserved verbatim — an
 * unverified channel datagram (`channelData`) never appears as a verified
 * `channel` message (AGENTS.md "provenance is structural").
 *
 * **Live updates.** The high-level `McpServer` handles resource list/read but
 * **not** subscriptions, so this registrar wires them on the low-level
 * `server.server`:
 *
 * - it declares the `resources.subscribe` capability (the {@link createServer}
 *   construction also passes it through, but registering here keeps the wiring
 *   cohesive and self-contained);
 * - it handles `resources/subscribe` / `resources/unsubscribe` by tracking the
 *   set of subscribed uris;
 * - it bridges {@link MeshService.onTraffic} → `sendResourceUpdated({ uri })`,
 *   so each newly-buffered event fires exactly one
 *   `notifications/resources/updated` for this uri — but **only** when there is
 *   an active subscriber. The notification carries only the uri; the client
 *   re-reads the resource to get the new events.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { MeshService } from "../service/mesh-service.js";

/** The canonical uri of the live-traffic resource. */
export const TRAFFIC_LIVE_URI = "meshcore://traffic/live";

/**
 * How many recent events a read returns. The buffer retains more (its ring
 * capacity), but a read is a bounded, high-signal slice — newest window,
 * oldest→newest within it.
 */
const READ_LIMIT = 100;

/**
 * Register the subscribable `meshcore://traffic/live` resource on `server`,
 * backed by `service`.
 *
 * Sets up, cohesively: the resource itself, the `resources.subscribe`
 * capability, the subscribe/unsubscribe tracking, and the
 * `onTraffic → sendResourceUpdated` bridge. Call **before** `server.connect()`
 * (the capability must be registered before a transport is attached, and the
 * Subscribe handler can only be set once the capability is declared).
 */
export function registerTrafficLive(server: McpServer, service: MeshService): void {
  const low = server.server;

  // Declare the subscribe capability before any handler is set or the
  // transport is connected. Idempotent with the capability createServer already
  // threads into construction; merged, not duplicated.
  low.registerCapabilities({ resources: { subscribe: true } });

  // The set of uris this client has an active subscription on. We only ever
  // push updates for TRAFFIC_LIVE_URI, and only while it is in this set — the
  // pull-style nodes/contacts resources never fire.
  const subscribed = new Set<string>();

  low.setRequestHandler(SubscribeRequestSchema, (req) => {
    subscribed.add(req.params.uri);
    return {};
  });
  low.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  // Each newly-buffered event → one resources/updated for the live uri, but
  // only when something is subscribed to it. Fire-and-forget: the push hook is
  // synchronous, the send is async; surfacing a send error here would have
  // nowhere useful to go (diagnostics are stderr-only, and stdout is the MCP
  // channel — AGENTS.md), so we swallow it.
  service.onTraffic(() => {
    if (!subscribed.has(TRAFFIC_LIVE_URI)) return;
    void low.sendResourceUpdated({ uri: TRAFFIC_LIVE_URI });
  });

  server.registerResource(
    "traffic-live",
    TRAFFIC_LIVE_URI,
    {
      title: "Live mesh traffic",
      description:
        "A rolling, subscribable feed of recent mesh traffic, each event tagged " +
        "with structural provenance (kind + decrypt-verified). Subscribe to be " +
        "notified as new events arrive, then re-read to fetch them. Verified " +
        "channel messages and unverified channel datagrams are marked " +
        "distinctly and never conflated.",
      mimeType: "application/json",
    },
    (uri) => {
      const events = service.recentTraffic().slice(-READ_LIMIT);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ events, count: events.length }, null, 2),
          },
        ],
      };
    },
  );
}
