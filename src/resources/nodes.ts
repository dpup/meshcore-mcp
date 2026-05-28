/**
 * `meshcore://nodes` — the mesh roster as a pull-style resource (PRD §5.2, M4).
 *
 * A read returns the same consolidated {@link MeshSurvey} that `survey_mesh`
 * (M2) does — the home node plus every known contact with its last-heard time,
 * role, and public key — as JSON. No subscription: it is a point-in-time
 * snapshot the client re-reads on demand.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resourceReadError } from "../errors.js";
import type { MeshService } from "../service/mesh-service.js";

/** The canonical uri of the nodes/roster resource. */
export const NODES_URI = "meshcore://nodes";

/** Register the `meshcore://nodes` roster resource on `server`, backed by `service`. */
export function registerNodes(server: McpServer, service: MeshService): void {
  server.registerResource(
    "nodes",
    NODES_URI,
    {
      title: "Mesh roster",
      description:
        "The mesh as seen through the home node: the home device plus every " +
        "known contact, each with its advertised role and last-heard time.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const survey = await service.surveyMesh();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(survey, null, 2),
            },
          ],
        };
      } catch (error) {
        resourceReadError(NODES_URI, error, "reading mesh roster");
      }
    },
  );
}
