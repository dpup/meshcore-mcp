/**
 * `set_contact_path` — pin an explicit forwarding path to a contact. Advanced;
 * for static routing when automatic path discovery is wrong or undesirable.
 *
 * Companion-protocol operation; local-only state change.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { digestSetContactPath, setContactPathOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `set_contact_path` tool on `server`, backed by `service`. */
export function registerSetContactPath(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "set_contact_path",
    config: {
      title: "Pin an explicit path to a contact",
      description:
        "Set an explicit forwarding path (a sequence of repeater path-hash " +
        "bytes, up to 64) to a contact. Advanced: only when you want to " +
        "override automatic path discovery. Pass `pathHex: \"\"` to mark the " +
        "contact as direct (no repeaters). Pair with `trace_path` to discover " +
        "a working path first.",
      inputSchema: {
        target: z.string().describe("contact name or hex public-key prefix"),
        pathHex: z
          .string()
          // 64 bytes max ⇒ 128 hex chars. Pairs only — an odd-length hex
          // string would crash `fromHex` at dispatch time; reject upfront.
          .max(128)
          .regex(/^([0-9a-fA-F]{2})*$/u, "must be an even-length hex byte string (or empty for direct)")
          .describe("repeater path-hash bytes as hex (max 64 bytes / 128 chars); empty string ⇒ direct (no hops)"),
      },
      outputSchema: setContactPathOutputShape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    errorContext: ({ target }) => ({ node: target, attempted: "setting the contact path" }),
    handle: async (svc, { target, pathHex }) => {
      const result = await svc.setContactPath(target, pathHex);
      return { text: digestSetContactPath(result), structured: result };
    },
  });
}
