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

// Configuration: env/flags → validated Config (M6). Useful to embedders that
// want to build their own client/service from the same environment contract.
export { loadConfig, ConfigError } from "./config.js";
export type { Config } from "./config.js";

// The injectable clock (PRD §6) — SystemClock in prod, SimClock in tests.
export { SystemClock, toMillis } from "./clock.js";
export type { Clock, Duration, TimerHandle } from "./clock.js";

// The device-facing core and the recent-traffic buffer.
export {
  MeshService,
  MeshServiceUnknownNodeError,
  AdminCommandError,
} from "./service/mesh-service.js";
export type {
  MeshServiceOptions,
  CredentialsProvider,
  SendMessageResult,
  AdminResult,
} from "./service/mesh-service.js";

// The enumerated admin command set (execution plan §9).
export { ADMIN_COMMANDS, ADMIN_COMMAND_NAMES, annotationsForTier } from "./service/admin.js";
export type {
  AdminCommandDef,
  RiskTier,
  AdminScope,
  TierAnnotations,
} from "./service/admin.js";
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
export { registerSendMessage } from "./tools/send-message.js";
export { registerSetChannel } from "./tools/set-channel.js";
export { registerDeleteChannel } from "./tools/delete-channel.js";
export { registerTracePath } from "./tools/trace-path.js";
export { registerAdmin } from "./tools/admin.js";
export { registerSetCredential } from "./tools/set-credential.js";
export { registerForgetCredential } from "./tools/forget-credential.js";
export { registerImportContact } from "./tools/import-contact.js";
export { registerExportContact } from "./tools/export-contact.js";
export { registerShareContact } from "./tools/share-contact.js";
export { registerRemoveContact } from "./tools/remove-contact.js";
export { registerResetPath } from "./tools/reset-path.js";
export { registerSetContactPath } from "./tools/set-contact-path.js";
export { registerSetAutoAddContacts } from "./tools/set-auto-add-contacts.js";
export { registerRebootNode } from "./tools/reboot-node.js";
export { registerBroadcastAdvert } from "./tools/broadcast-advert.js";
export { registerSyncClock } from "./tools/sync-clock.js";
export { registerSetTxPower } from "./tools/set-tx-power.js";
export { registerSetRadio } from "./tools/set-radio.js";
export { registerSetNodeName } from "./tools/set-node-name.js";
export { registerSetNodeLocation } from "./tools/set-node-location.js";
export { registerHomeAdminTool } from "./tools/home-admin-helpers.js";
export type { HomeAdminToolOptions } from "./tools/home-admin-helpers.js";

// The runtime-managed credential store — the third injected seam (alongside
// MeshCoreClient and Clock). Persists the per-node login passwords the
// `set_credential` / `forget_credential` tools push in. `composeCredentials`
// is the single source of truth for the layering precedence used by both
// production (cli.ts) and the test harness.
export {
  InMemoryCredentialStore,
  JsonFileCredentialStore,
  CredentialStoreError,
  composeCredentials,
  defaultCredentialFs,
} from "./store/credential-store.js";
export type {
  CredentialStore,
  CredentialFs,
  JsonFileCredentialStoreOptions,
} from "./store/credential-store.js";

// Resource registrars (wired by createServer; exported for reuse/inspection).
export { registerTrafficLive, TRAFFIC_LIVE_URI } from "./resources/traffic-live.js";
export { registerNodes, NODES_URI } from "./resources/nodes.js";
export { registerContacts, CONTACTS_URI } from "./resources/contacts.js";
export { registerChannels, CHANNELS_URI } from "./resources/channels.js";
export { registerNode } from "./resources/node.js";
export { registerHelp, HELP_URI } from "./resources/help.js";

// Prompt registrar — the curated prompt templates (M5).
export { registerPrompts } from "./prompts/index.js";

// The actionable tool-error helper.
export { toolError } from "./errors.js";
export type { ToolErrorResult, ErrorContext } from "./errors.js";

// Time formatting (coarse "ago" / duration phrasing) — formatRelative stays on
// the public surface (kept here for the unchanged `import { formatRelative }
// from "../src/index.js"` in tests); its definition now lives in time.ts.
export { formatRelative } from "./time.js";
