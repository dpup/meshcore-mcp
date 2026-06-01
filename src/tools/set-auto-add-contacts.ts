/**
 * `set_auto_add_contacts` — toggle whether new contacts heard via adverts are
 * appended to the local roster automatically (companion default) or only
 * when an `import_contact` call asks for them.
 *
 * Companion-protocol operation; local-only state change.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestSetAutoAddContacts, setAutoAddContactsOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `set_auto_add_contacts` tool on `server`, backed by `service`. */
export function registerSetAutoAddContacts(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "set_auto_add_contacts",
    config: {
      title: "Toggle auto-add for new contacts",
      description:
        "Set whether new contacts heard via adverts are added to the local " +
        "roster automatically (`autoAdd: true`, the companion default) or " +
        "only when explicitly imported (`autoAdd: false`). Manual mode pairs " +
        "well with `remove_contact` for a curated contact list.",
      inputSchema: {
        autoAdd: z
          .boolean()
          .describe("true to auto-add new adverts; false to require import_contact"),
      },
      outputSchema: setAutoAddContactsOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    errorContext: () => ({ attempted: "setting auto-add contacts" }),
    handle: async (svc, { autoAdd }) => {
      const result = await svc.setAutoAddContacts(autoAdd);
      return { text: digestSetAutoAddContacts(result), structured: result };
    },
  });
}
