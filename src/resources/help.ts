import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { helpDocument } from "../help.js";

/** The URI of the help document resource. */
export const HELP_URI = "meshcore://help";

/**
 * Register the pull-style `meshcore://help` resource — a markdown reference an
 * agent can fetch on demand when it wants more than the `initialize`
 * instructions. Static content; needs no {@link MeshService}.
 */
export function registerHelp(server: McpServer): void {
  server.registerResource(
    "help",
    HELP_URI,
    {
      title: "meshcore-mcp help",
      description: "How to use this server — orientation, the admin catalogue, and recipes.",
      mimeType: "text/markdown",
    },
    () => ({
      contents: [{ uri: HELP_URI, mimeType: "text/markdown", text: helpDocument() }],
    }),
  );
}
