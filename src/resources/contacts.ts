/**
 * `meshcore://contacts` — the device's contact list as a pull-style resource
 * (PRD §5.2, M4).
 *
 * A read returns the typed {@link Contact} models from
 * {@link MeshService.contacts} as JSON. No subscription: a point-in-time
 * snapshot the client re-reads on demand. `Date` fields (`lastAdvert`,
 * `lastMod`) serialize to ISO strings via `JSON.stringify`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";

/** The canonical uri of the contacts resource. */
export const CONTACTS_URI = "meshcore://contacts";

/** Register the `meshcore://contacts` resource on `server`, backed by `service`. */
export function registerContacts(server: McpServer, service: MeshService): void {
  server.registerResource(
    "contacts",
    CONTACTS_URI,
    {
      title: "Contacts",
      description:
        "The home node's stored contact list — each contact's name, public key, " +
        "role, advertised location, and last-heard time.",
      mimeType: "application/json",
    },
    async (uri) => {
      const contacts = await service.contacts();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ contacts, count: contacts.length }, null, 2),
          },
        ],
      };
    },
  );
}
