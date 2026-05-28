/**
 * `send_message` — transmit a text message to a contact or a channel (PRD §5.1).
 *
 * The service resolves `target` as a contact (name / hex prefix) or a channel
 * (`#name`, `#idx`, or a bare index) and routes to the matching typed client
 * method. The annotations say this is an **action**: not read-only, and
 * **`idempotentHint: false`** — a resend is a second transmission on the air,
 * never a no-op repeat (PRD §5.3). An unknown target yields an actionable
 * `isError` result, not a crash.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { digestSendMessage, sendMessageOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/** Register the `send_message` action tool on `server`, backed by `service`. */
export function registerSendMessage(server: McpServer, service: MeshService): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a message",
      description:
        "Transmit a text message. `target` is a contact (name or hex public-key " +
        "prefix) or a channel (`#name`, `#index`, or a bare channel index). A " +
        "resend is a second transmission — not idempotent.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "a contact (name or hex public-key prefix) or a channel (`#name`, `#index`, or a bare channel index)",
          ),
        text: z.string().describe("the message text to transmit"),
      },
      outputSchema: sendMessageOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ target, text }) => {
      try {
        const result = await service.sendMessage(target, text);
        return {
          content: [{ type: "text", text: digestSendMessage(result) }],
          // Widen to the SDK's record shape; the outputSchema validates it.
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        // No `node` prefix: the resolution errors already name the target, and a
        // channel/contact miss is a usage error, not "<target> unreachable".
        return toolError(error, { attempted: "sending the message" });
      }
    },
  );
}
