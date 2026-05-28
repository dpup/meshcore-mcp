import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MeshService } from "../service/mesh-service.js";
import { registerJsonResource } from "./register.js";

/** The URI of the channels list resource. */
export const CHANNELS_URI = "meshcore://channels";

/**
 * Register the pull-style `meshcore://channels` resource — the connected node's
 * configured channel slots (index, name, and the hex key, so a channel can be
 * shared or rejoined). Add channels with the `set_channel` tool.
 */
export function registerChannels(server: McpServer, service: MeshService): void {
  registerJsonResource(server, {
    name: "channels",
    uri: CHANNELS_URI,
    metadata: {
      title: "Channels",
      description: "Configured channel slots on the connected node (index, name, key).",
      mimeType: "application/json",
    },
    attempted: "reading channels",
    load: async () => {
      // The device returns every slot (often dozens); show only configured
      // ones (a non-empty name) so the list is signal, not 40 empty rows.
      const channels = (await service.channels())
        .filter((c) => c.name !== "")
        .map((c) => ({ index: c.channelIdx, name: c.name, secret: c.secret }));
      return { channels, count: channels.length };
    },
  });
}
