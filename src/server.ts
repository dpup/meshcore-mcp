import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerPrompts } from "./prompts/index.js";
import { registerChannels } from "./resources/channels.js";
import { registerContacts } from "./resources/contacts.js";
import { registerHelp } from "./resources/help.js";
import { registerNode } from "./resources/node.js";
import { registerNodes } from "./resources/nodes.js";
import { registerTrafficLive } from "./resources/traffic-live.js";
import type { MeshService } from "./service/mesh-service.js";
import { registerAdmin } from "./tools/admin.js";
import { registerExportContact } from "./tools/export-contact.js";
import { registerForgetCredential } from "./tools/forget-credential.js";
import { registerGetNodeHealth } from "./tools/get-node-health.js";
import { registerGetRecentTraffic } from "./tools/get-recent-traffic.js";
import { registerImportContact } from "./tools/import-contact.js";
import { registerDeleteChannel } from "./tools/delete-channel.js";
import { registerUnwrappedAdminTools } from "./tools/home-admin-helpers.js";
import { registerRemoveContact } from "./tools/remove-contact.js";
import { registerResetPath } from "./tools/reset-path.js";
import { registerSendMessage } from "./tools/send-message.js";
import { registerSetAutoAddContacts } from "./tools/set-auto-add-contacts.js";
import { registerSetChannel } from "./tools/set-channel.js";
import { registerSetContactPath } from "./tools/set-contact-path.js";
import { registerSetCredential } from "./tools/set-credential.js";
import { registerShareContact } from "./tools/share-contact.js";
import { registerSurveyMesh } from "./tools/survey-mesh.js";
import { registerTracePath } from "./tools/trace-path.js";
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
      ? { capabilities: { resources: { subscribe: true } }, instructions: SERVER_INSTRUCTIONS }
      : {},
  );

  // The tools (PRD §5.1) need a MeshService to call. With one, register the read
  // tools (M2), the action tools (M3: send_message, admin), the resources (M4:
  // nodes, contacts, and the subscribable live stream), and the curated prompt
  // templates (M5); without one (the M0 smoke path) the server stays empty. The
  // prompts are pure content and don't need the service, but they register here
  // so the empty path advertises nothing.
  if (options.service !== undefined) {
    registerGetNodeHealth(server, options.service);
    registerSurveyMesh(server, options.service);
    registerGetRecentTraffic(server, options.service);
    registerSendMessage(server, options.service);
    registerSetChannel(server, options.service);
    registerDeleteChannel(server, options.service);
    registerTracePath(server, options.service);
    registerAdmin(server, options.service);
    // Server-state credential tools — no device contact; runtime-managed
    // login passwords for remote nodes (see src/store/credential-store.ts).
    registerSetCredential(server, options.service);
    registerForgetCredential(server, options.service);

    // Contact-management tools — companion-protocol operations on the local
    // node's roster. No equivalent for remote nodes (the companion protocol
    // is what reaches the local device's contact list).
    registerImportContact(server, options.service);
    registerExportContact(server, options.service);
    registerShareContact(server, options.service);
    registerRemoveContact(server, options.service);
    registerResetPath(server, options.service);
    registerSetContactPath(server, options.service);
    registerSetAutoAddContacts(server, options.service);

    // Unwrapped admin tools — top-level wrappers around the 7 home+remote
    // ADMIN_COMMANDS entries so their per-command annotations (read-only /
    // destructive / idempotent) reach the agent via MCP tool metadata. The
    // multiplexed `admin` tool keeps these too for back-compat. The full
    // list lives in `home-admin-helpers.ts` as `UNWRAPPED_ADMIN_TOOLS`.
    registerUnwrappedAdminTools(server, options.service);

    registerNodes(server, options.service);
    registerContacts(server, options.service);
    registerChannels(server, options.service);
    registerTrafficLive(server, options.service);
    registerNode(server, options.service); // meshcore://node/{node} — completes node names
    registerHelp(server); // meshcore://help — pull-on-demand reference

    registerPrompts(server, options.service);
  }

  return server;
}
