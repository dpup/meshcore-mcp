/**
 * Curated prompt templates (PRD §5.4, M5).
 *
 * A small, deliberately-shaped set of parameterized starting prompts for the
 * **human-operator / Claude Code** consumer — pre-built entry points that encode
 * recurring operator intent (a morning mesh check, diagnosing a quiet node,
 * drafting an outage notice). meshcore-elmer's autonomous consumers bring their
 * own prompting and ignore these.
 *
 * **A prompt frames; it does not freeze.** This is where workflow know-how
 * legitimately lives — kept *out* of the tools (PRD §4). Each template poses a
 * well-formed task and points the agent at the **real tools** (`survey_mesh`,
 * `get_recent_traffic`, `get_node_health`, `send_message`) by name; the agent
 * still reasons freely. Framing, not control flow.
 *
 * **No policy, no secrets.** A template is content, not authority — the same
 * boundary that applies everywhere else (PRD §5.4). They compose with the tools
 * and resources; they never re-implement device logic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Frame a single `user` message as a {@link GetPromptResult}-shaped value. */
function userMessage(description: string, text: string) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

/**
 * Register the curated prompt templates on `server`.
 *
 * Prompts are pure content — they don't touch the {@link MeshService} — but
 * {@link createServer} registers them inside the service-present block so the
 * empty M0 smoke path stays empty.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "morning-mesh-check",
    {
      title: "Morning mesh check",
      description:
        "A daily health sweep of the mesh: survey the roster, flag nodes not " +
        "heard from recently, and spot-check anything that looks off.",
    },
    () =>
      userMessage(
        "Daily mesh health sweep — survey, flag quiet nodes, spot-check the suspicious ones.",
        [
          "Do a morning health sweep of the mesh and give me a short situation report.",
          "",
          "Start with `survey_mesh` to get the current roster and each node's last-heard",
          "time, then flag any node you haven't heard from recently or that looks off.",
          "Use `get_recent_traffic` to see what has actually been moving on the air and",
          "whether the quiet nodes are genuinely silent or just sparse. For anything that",
          "looks suspicious — a repeater gone quiet, a low battery, a flapping link — run",
          "`get_node_health` on that node to confirm.",
          "",
          "Reason freely about what's normal for this mesh; close with a brief summary of",
          "what's healthy, what's worth watching, and anything that needs action.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "diagnose-quiet-node",
    {
      title: "Diagnose a quiet node",
      description:
        "Work out why a specific node has gone quiet: check its health, recent " +
        "traffic to and from it, when it was last heard, and its neighbours.",
      argsSchema: { node: z.string() },
    },
    ({ node }) =>
      userMessage(
        `Diagnose why "${node}" has gone quiet.`,
        [
          `The node "${node}" (a contact name or hex public-key prefix) seems to have`,
          "gone quiet. Work out why.",
          "",
          `Run \`get_node_health\` with node "${node}" to check whether it's reachable and`,
          "what its radio, battery, and uptime look like. Use `get_recent_traffic` to see",
          `the most recent traffic to and from "${node}" and when it was last heard. Run`,
          "`survey_mesh` to place it in context — its advertised role, its last-heard time",
          "relative to its neighbours, and whether nearby nodes are still active (a quiet",
          "neighbourhood points at a different cause than a single quiet node).",
          "",
          "Reason freely from the evidence — distinguish offline, out of range, low",
          "battery, and a healthy-but-idle node — and conclude with the most likely cause",
          "and a suggested next step.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "draft-outage-notice",
    {
      title: "Draft an outage notice",
      description:
        "Draft a concise outage notice for a node over a time window, and " +
        "optionally send it once you approve.",
      argsSchema: { node: z.string(), window: z.string().optional() },
    },
    ({ node, window }) => {
      const windowText = window ?? "the recent outage window";
      return userMessage(
        `Draft an outage notice for "${node}" over ${windowText}.`,
        [
          `Draft a concise outage notice for the node "${node}" covering ${windowText}.`,
          "",
          `First run \`get_node_health\` on "${node}" to ground the notice in its current`,
          `state — whether it's back, still down, and any relevant detail (battery, last`,
          "heard, radio). Then draft a short, plain notice an operator would post: what",
          `was affected ("${node}"), the window (${windowText}), current status, and any`,
          "expected next update. Keep it factual and brief — no speculation.",
          "",
          "Show me the draft for approval. Once I approve, send it with `send_message` to",
          "the channel or contact I name.",
        ].join("\n"),
      );
    },
  );
}
