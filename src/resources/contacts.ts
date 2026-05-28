/**
 * `meshcore://contacts` — the device's contact list as a pull-style resource
 * (PRD §5.2, M4).
 *
 * A read returns the **intent-shaped** `SurveyContact` projection from
 * {@link MeshService.contacts} (name, publicKey, role, lastHeardMs) as JSON —
 * never the raw meshcore-ts `Contact` internals (flags, out-paths, hop counts).
 * The shape is owned by the service (mirrored by `contactsOutputShape` in
 * `format.ts`), so a library `Contact` reshape can't silently change this
 * resource's contract. No subscription: a point-in-time snapshot the client
 * re-reads on demand. `lastHeardMs` is an injected-clock ms number.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerJsonResource } from "./register.js";

/** The canonical uri of the contacts resource. */
export const CONTACTS_URI = "meshcore://contacts";

/** Register the `meshcore://contacts` resource on `server`, backed by `service`. */
export function registerContacts(server: McpServer, service: MeshService): void {
  registerJsonResource(server, {
    name: "contacts",
    uri: CONTACTS_URI,
    metadata: {
      title: "Contacts",
      description:
        "The home node's stored contact list — each contact's name, public key, " +
        "role, and last-heard time.",
      mimeType: "application/json",
    },
    attempted: "reading contacts",
    load: async () => {
      const contacts = await service.contacts();
      return { contacts, count: contacts.length };
    },
  });
}
