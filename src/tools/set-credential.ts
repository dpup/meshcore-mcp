/**
 * `set_credential` — store (or overwrite) the password the server logs into a
 * remote node with for admin / remote-health calls, write-through to the
 * persisted credential store.
 *
 * **Server-state-only**, like `get_recent_traffic`: this never touches the
 * device. It is intentionally *separate* from the `set-admin-password` admin
 * command, which changes the *node's* admin password over the wire — this
 * one only changes the server's local memory of which password to send at
 * login (a use case the env-only credentials map cannot cover, e.g. an agent
 * that receives a password over a DM).
 *
 * The stored password is never echoed back: the structured output is just
 * `{ node, stored: true }`, and the text digest names the node only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Output schema for `set_credential` — no password echo, by design. */
export const setCredentialOutputShape = {
  node: z.string(),
  stored: z.literal(true),
} as const;

/** Register the `set_credential` tool on `server`, backed by `service`. */
export function registerSetCredential(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "set_credential",
    config: {
      title: "Remember a node's admin password",
      description:
        "Persist the password the server will use to log into `node` for " +
        "subsequent `admin` and remote `get_node_health` calls. Use this when " +
        "you've learned a repeater's admin password out of band (e.g. via DM) " +
        "and need the server to remember it across restarts. This is **the " +
        "server's local credential**, not the node's password — it does not " +
        "send anything over the mesh. The node must already be known (in the " +
        "contact list) — a typo'd name is rejected so credentials don't " +
        "silently land under a key that's never looked up. Overwrites any " +
        "existing entry. The password (max 256 chars) is stored in the " +
        "credentials file under `MESHCORE_STATE_DIR` with `0600` permissions, " +
        "and is never echoed in the tool result. Separate from the " +
        "`set-admin-password` admin command (which changes the node's own " +
        "password).",
      inputSchema: {
        node: z
          .string()
          .describe(
            "contact name or hex public-key prefix of the node — must already " +
              "be in the device's contact list (a typo'd node is rejected)",
          ),
        password: z
          .string()
          .max(256)
          .describe("the login password the server should use for this node (max 256 chars)"),
      },
      outputSchema: setCredentialOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        // No mesh traffic — pure server state.
        openWorldHint: false,
      },
    },
    errorContext: ({ node }) => ({
      node,
      attempted: "storing the credential",
    }),
    handle: async (svc, { node, password }) => {
      await svc.setCredential(node, password);
      return {
        text: `Stored credential for ${node}.`,
        structured: { node, stored: true as const },
      };
    },
  });
}
