import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { digestSetChannel, setChannelOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/**
 * `set_channel` — add or overwrite a channel slot on the connected node. Channel
 * config is a home-node (companion) operation with no remote-CLI form, so it is
 * its own tool rather than an `admin` command. Omit `secret` to generate a
 * random private channel; omit `index` to take the next free slot (a plain add
 * never clobbers an existing channel).
 */
export function registerSetChannel(server: McpServer, service: MeshService): void {
  server.registerTool(
    "set_channel",
    {
      title: "Add or update a channel",
      description:
        "Configure a channel slot on the connected node. Omit `secret` to generate " +
        "a random private channel; omit `index` to use the next free slot (so a " +
        "plain add won't overwrite an existing channel). Returns the channel's key " +
        "so you can share it. List channels via the `meshcore://channels` resource.",
      inputSchema: {
        name: z.string().describe("the channel name"),
        secret: z
          .string()
          .regex(/^[0-9a-fA-F]{32}$/u, "must be a 16-byte key as 32 hex characters")
          .optional()
          .describe("16-byte key as 32 hex chars; omit to generate a random private channel"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("channel slot to write; omit to use the next free slot"),
      },
      outputSchema: setChannelOutputShape,
      // Writes config but loses no data on a plain add (next-free slot); marked
      // non-read-only, idempotent (same args ⇒ same slot), not destructive.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, secret, index }) => {
      try {
        const result = await service.setChannel({ name, secret, index });
        return {
          content: [{ type: "text", text: digestSetChannel(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error, { node: "home", attempted: `setting channel "${name}"` });
      }
    },
  );
}
