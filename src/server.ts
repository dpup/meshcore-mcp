import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerContacts } from "./resources/contacts.js";
import { registerNodes } from "./resources/nodes.js";
import { registerTrafficLive } from "./resources/traffic-live.js";
import type { MeshService } from "./service/mesh-service.js";
import { registerAdmin } from "./tools/admin.js";
import { registerGetNodeHealth } from "./tools/get-node-health.js";
import { registerGetRecentTraffic } from "./tools/get-recent-traffic.js";
import { registerSendMessage } from "./tools/send-message.js";
import { registerSurveyMesh } from "./tools/survey-mesh.js";
import { VERSION } from "./version.js";

/**
 * Options for {@link createServer}.
 *
 * Carries the {@link MeshService} the tools are wired against. When a `service`
 * is supplied the read tools (M2) are registered onto the server; when it is
 * absent (M0's `cli.ts` smoke path) the server is left empty.
 */
export interface CreateServerOptions {
  /** Server name advertised to clients. Defaults to `"meshcore-mcp"`. */
  name?: string;
  /** Server version advertised to clients. Defaults to the package version. */
  version?: string;
  /**
   * The device-facing core the tools call. When provided, the read tools are
   * registered; when omitted, the server is created empty.
   */
  service?: MeshService;
}

/**
 * Build the meshcore-mcp {@link McpServer}.
 *
 * The tool, resource, and prompt surface (PRD §5) is registered onto this
 * server in later milestones. Connect the returned server to a transport with
 * `server.connect()` — a `StdioServerTransport` in production (see `cli.ts`), or
 * an `InMemoryTransport` linked to a `Client` in tests.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  // Thread the resources.subscribe capability into construction *only* when a
  // service is present — the live resource needs it (M4). The M0 empty-server
  // smoke path declares no capability, so it advertises a bare resource-less
  // server. registerTrafficLive re-declares the same capability (merged, not
  // duplicated), keeping its subscription wiring self-contained.
  const server = new McpServer(
    {
      name: options.name ?? "meshcore-mcp",
      version: options.version ?? VERSION,
    },
    options.service !== undefined
      ? { capabilities: { resources: { subscribe: true } } }
      : {},
  );

  // The tools (PRD §5.1) need a MeshService to call. With one, register the read
  // tools (M2), the action tools (M3: send_message, admin), and the resources
  // (M4: nodes, contacts, and the subscribable live stream); without one (the
  // M0 smoke path) the server stays empty. Prompts (M5) land here next.
  if (options.service !== undefined) {
    registerGetNodeHealth(server, options.service);
    registerSurveyMesh(server, options.service);
    registerGetRecentTraffic(server, options.service);
    registerSendMessage(server, options.service);
    registerAdmin(server, options.service);

    registerNodes(server, options.service);
    registerContacts(server, options.service);
    registerTrafficLive(server, options.service);
  }

  return server;
}
