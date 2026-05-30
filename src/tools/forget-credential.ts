/**
 * `forget_credential` — remove a node's stored login password from the
 * persisted credential store. Subsequent `admin` / remote `get_node_health`
 * calls fall back to the env-default credential resolver (the guest password
 * by default).
 *
 * Server-state-only — never contacts the device. The result's `removed` flag
 * is `false` when there was nothing to remove (the call still succeeds; the
 * end state is identical either way).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Output schema for `forget_credential`. */
export const forgetCredentialOutputShape = {
  node: z.string(),
  removed: z.boolean(),
} as const;

/** Register the `forget_credential` tool on `server`, backed by `service`. */
export function registerForgetCredential(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "forget_credential",
    config: {
      title: "Forget a node's stored admin password",
      description:
        "Remove the server's stored login password for `node`. Subsequent " +
        "`admin` / remote `get_node_health` calls fall back to the env " +
        "default credential (the guest password, unless " +
        "`MESHCORE_LOGIN_PASSWORD` / `MESHCORE_NODE_PASSWORDS` is set). " +
        "`removed` is false when no entry existed — the end state is the " +
        "same either way. Marked destructive: the stored password is " +
        "gone after this call.",
      inputSchema: {
        node: z
          .string()
          .describe("contact name or hex public-key prefix of the node"),
      },
      outputSchema: forgetCredentialOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    errorContext: ({ node }) => ({
      node,
      attempted: "forgetting the credential",
    }),
    handle: async (svc, { node }) => {
      const removed = await svc.forgetCredential(node);
      return {
        text: removed
          ? `Forgot credential for ${node}.`
          : `No stored credential for ${node}.`,
        structured: { node, removed },
      };
    },
  });
}
