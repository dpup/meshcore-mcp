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

import { digestSendMessage, sendMessageOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `send_message` action tool on `server`, backed by `service`. */
export function registerSendMessage(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "send_message",
    config: {
      title: "Send a message",
      description:
        "Transmit a text message. `target` is a contact (name or hex public-key " +
        "prefix) or a channel (`#name`, `#index`, or a bare channel index). A " +
        "resend is a second transmission — not idempotent. Set `confirm: true` to " +
        "wait for the delivery ack and report whether it arrived + the round-trip " +
        "time. Confirmation applies to **direct (contact) messages only**: a " +
        "channel/broadcast has no single recipient to ack, so a `confirm: true` " +
        "channel send returns `confirmationNotApplicable: true` (and no " +
        "`delivered`) rather than silently ignoring the request.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "a contact (name or hex public-key prefix) or a channel (`#name`, `#index`, or a bare channel index)",
          ),
        text: z.string().describe("the message text to transmit"),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "wait for and report the delivery ack + round-trip. Direct (contact) messages only — for a channel/broadcast send the result reports `confirmationNotApplicable: true` instead (no single recipient to ack)",
          ),
      },
      outputSchema: sendMessageOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    // No `node` prefix: the resolution errors already name the target, and a
    // channel/contact miss is a usage error, not "<target> unreachable".
    errorContext: () => ({ attempted: "sending the message" }),
    handle: async (svc, { target, text, confirm }) => {
      const result = await svc.sendMessage(target, text, { confirm: confirm ?? false });
      return { text: digestSendMessage(result), structured: result };
    },
  });
}
