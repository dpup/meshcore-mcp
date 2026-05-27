import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "./service/mesh-service.js";
import { registerGetNodeHealth } from "./tools/get-node-health.js";
import { registerGetRecentTraffic } from "./tools/get-recent-traffic.js";
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
  const server = new McpServer({
    name: options.name ?? "meshcore-mcp",
    version: options.version ?? VERSION,
  });

  // The read tools (PRD §5.1) need a MeshService to call. With one, register
  // them; without one (the M0 smoke path) the server stays empty. Action tools
  // (M3), resources (M4), and prompts (M5) land here next.
  if (options.service !== undefined) {
    registerGetNodeHealth(server, options.service);
    registerSurveyMesh(server, options.service);
    registerGetRecentTraffic(server, options.service);
  }

  return server;
}
