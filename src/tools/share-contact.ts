/**
 * `share_contact` — broadcast a contact's advert mesh-wide so other nodes
 * learn its identity (public key, name, location) without having heard the
 * contact's own advert.
 *
 * Sends mesh traffic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestShareContact, shareContactOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `share_contact` tool on `server`, backed by `service`. */
export function registerShareContact(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "share_contact",
    config: {
      title: "Share a contact mesh-wide",
      description:
        "Broadcast a contact's advert across the mesh. Other nodes that receive " +
        "the advert can route to this contact without having heard its own " +
        "transmissions. Costs airtime.",
      inputSchema: {
        target: z.string().describe("contact name or hex public-key prefix to share"),
      },
      outputSchema: shareContactOutputShape,
      annotations: {
        readOnlyHint: false,
        // Not idempotent — each call transmits a fresh advert.
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    errorContext: ({ target }) => ({ node: target, attempted: "sharing the contact" }),
    handle: async (svc, { target }) => {
      const result = await svc.shareContact(target);
      return { text: digestShareContact(result), structured: result };
    },
  });
}
