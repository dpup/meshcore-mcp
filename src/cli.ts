#!/usr/bin/env node
/**
 * meshcore-mcp entrypoint.
 *
 * Builds the server and serves it over stdio — the local-process transport an
 * MCP client (Claude Code, or meshcore-elmer's bridge) launches and speaks to.
 * Configuration and the live MeshCore connection are wired in M6; for now this
 * starts an empty server so the transport and `initialize` handshake can be
 * exercised end to end.
 *
 * Note: stdout is the MCP protocol channel — all diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("meshcore-mcp failed to start:", err);
  process.exitCode = 1;
});
