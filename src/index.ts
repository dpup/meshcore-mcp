/**
 * meshcore-mcp — a Model Context Protocol server that exposes a MeshCore node,
 * and the mesh reachable through it, as a clean, high-signal interface for AI
 * agents and tools.
 *
 * It wraps a [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts)
 * `MeshCoreClient` behind a small, deliberately shaped surface of MCP tools,
 * resources, and prompts. Run it as a local-process server (see the
 * `meshcore-mcp` binary / `cli.ts`), or embed {@link createServer} and connect
 * your own transport.
 *
 * @packageDocumentation
 */

export { VERSION } from "./version.js";

// The MCP server factory.
export { createServer } from "./server.js";
export type { CreateServerOptions } from "./server.js";
