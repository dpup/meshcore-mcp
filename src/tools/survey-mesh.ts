/**
 * `survey_mesh` — one consolidated roster of the mesh as seen through the home
 * node: the home device plus every known contact, each with its last-heard
 * time, role, and public key (PRD §5.1).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { digestMeshSurvey, meshSurveyOutputShape } from "../format.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Register the `survey_mesh` read tool on `server`, backed by `service`. */
export function registerSurveyMesh(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "survey_mesh",
    config: {
      title: "Survey the mesh",
      description:
        "List the home node and every known contact, with each contact's " +
        "advertised role and last-heard time — a roster for spotting quiet or " +
        "missing nodes.",
      inputSchema: {},
      outputSchema: meshSurveyOutputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    errorContext: () => ({ attempted: "surveying the mesh" }),
    handle: async (svc) => {
      const survey = await svc.surveyMesh();
      return { text: digestMeshSurvey(survey, svc.now()), structured: survey };
    },
  });
}
