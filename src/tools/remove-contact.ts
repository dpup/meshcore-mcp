/**
 * `remove_contact` — drop a contact from the local node's roster.
 *
 * Companion-protocol operation; local-only. The contact may reappear if its
 * advert is heard again (depending on the auto-add setting; see
 * `set_auto_add_contacts`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestRemoveContact, removeContactOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `remove_contact` tool on `server`, backed by `service`. */
export function registerRemoveContact(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "remove_contact",
    config: {
      title: "Remove a contact",
      description:
        "Drop a contact from the local node's roster. Local-only — does not " +
        "tell any other node. The contact may reappear if its advert is heard " +
        "again under auto-add mode; combine with `set_auto_add_contacts " +
        "{ autoAdd: false }` for a sticky removal.",
      inputSchema: {
        target: z.string().describe("contact name or hex public-key prefix to remove"),
      },
      outputSchema: removeContactOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    errorContext: ({ target }) => ({ node: target, attempted: "removing the contact" }),
    handle: async (svc, { target }) => {
      const result = await svc.removeContact(target);
      return { text: digestRemoveContact(result), structured: result };
    },
  });
}
