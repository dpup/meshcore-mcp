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

// The injectable clock (PRD §6) — SystemClock in prod, SimClock in tests.
export { SystemClock, toMillis } from "./clock.js";
export type { Clock, Duration, TimerHandle } from "./clock.js";

// The device-facing core and the recent-traffic buffer.
export { MeshService, MeshServiceUnknownNodeError } from "./service/mesh-service.js";
export type { MeshServiceOptions, CredentialsProvider } from "./service/mesh-service.js";
export { TrafficBuffer, DEFAULT_TRAFFIC_CAPACITY } from "./service/traffic-buffer.js";
export type { TrafficEvent, TrafficKind } from "./service/traffic-buffer.js";

// The unified read-tool result types.
export type {
  NodeHealth,
  MeshSurvey,
  SurveyContact,
} from "./service/health.js";

// Tool registrars (wired by createServer; exported for reuse/inspection).
export { registerGetNodeHealth } from "./tools/get-node-health.js";
export { registerSurveyMesh } from "./tools/survey-mesh.js";
export { registerGetRecentTraffic } from "./tools/get-recent-traffic.js";

// The actionable tool-error helper.
export { toolError, formatRelative } from "./errors.js";
export type { ToolErrorResult, ErrorContext } from "./errors.js";
