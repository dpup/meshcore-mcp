import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { VERSION } from "./version.js";

/**
 * Options for {@link createServer}.
 *
 * From M1 onward this also carries the `MeshService` the tools, resources, and
 * prompts are wired against; in M0 the server is intentionally empty.
 */
export interface CreateServerOptions {
  /** Server name advertised to clients. Defaults to `"meshcore-mcp"`. */
  name?: string;
  /** Server version advertised to clients. Defaults to the package version. */
  version?: string;
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

  // Tools (PRD §5.1), resources (§5.2), and prompts (§5.4) are registered here
  // in M2–M5.

  return server;
}
