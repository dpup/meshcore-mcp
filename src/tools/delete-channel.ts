import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { deleteChannelOutputShape, digestDeleteChannel } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";

/**
 * `delete_channel` — clear a channel slot on the connected node, by `index` or
 * by `name`. The companion counterpart to `set_channel`; like it, a home-node
 * config operation (its own tool, not an `admin` command).
 */
export function registerDeleteChannel(server: McpServer, service: MeshService): void {
  server.registerTool(
    "delete_channel",
    {
      title: "Delete a channel",
      description:
        "Remove a channel slot on the connected node, addressed by `index` or by " +
        "`name`. List channels via the `meshcore://channels` resource.",
      inputSchema: {
        index: z.number().int().min(0).optional().describe("channel slot to delete"),
        name: z.string().optional().describe("channel name to delete (resolved to its slot)"),
      },
      outputSchema: deleteChannelOutputShape,
      // Removes a channel — destructive; idempotent (an emptied slot stays empty).
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ index, name }) => {
      try {
        const result = await service.deleteChannel({ index, name });
        return {
          content: [{ type: "text", text: digestDeleteChannel(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error, { attempted: "deleting the channel" });
      }
    },
  );
}
