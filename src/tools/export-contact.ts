/**
 * `export_contact` — return a contact's advert-packet bytes (hex) so they can
 * be imported elsewhere. With no `target`, exports the home node's own advert.
 *
 * Companion-protocol read; no mesh traffic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestExportContact, exportContactOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `export_contact` tool on `server`, backed by `service`. */
export function registerExportContact(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "export_contact",
    config: {
      title: "Export a contact",
      description:
        "Return the advert-packet bytes (hex) for a contact, suitable for " +
        "another node's `import_contact`. Omit `target` to export the home " +
        "node's own advert (useful for sharing identity off-mesh).",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe("contact name or hex public-key prefix; omit to export the home node"),
      },
      outputSchema: exportContactOutputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    errorContext: ({ target }) => ({
      node: target,
      attempted: "exporting the contact",
    }),
    handle: async (svc, { target }) => {
      const result = await svc.exportContact(target);
      return { text: digestExportContact(result), structured: result };
    },
  });
}
