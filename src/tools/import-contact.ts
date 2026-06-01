/**
 * `import_contact` — add a contact to the local node's roster from
 * advert-packet bytes (typically obtained by another node's `export_contact`).
 *
 * Companion-protocol operation — operates on the local node's contact list
 * only. No mesh traffic until subsequent sends/adverts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestImportContact, importContactOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `import_contact` tool on `server`, backed by `service`. */
export function registerImportContact(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "import_contact",
    config: {
      title: "Import a contact",
      description:
        "Add a contact to the local node's roster from its advert-packet bytes " +
        "(hex). Typically obtained from another node's `export_contact`, a QR " +
        "scan, or another out-of-band channel. The contact appears in " +
        "`survey_mesh` and the `meshcore://contacts` resource after this.",
      inputSchema: {
        advertHex: z
          .string()
          .regex(/^[0-9a-fA-F]+$/u, "must be hex bytes")
          .describe("the advert packet as hex bytes (e.g. the output of export_contact)"),
      },
      outputSchema: importContactOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    errorContext: () => ({ attempted: "importing the contact" }),
    handle: async (svc, { advertHex }) => {
      const result = await svc.importContact(advertHex);
      return { text: digestImportContact(result), structured: result };
    },
  });
}
