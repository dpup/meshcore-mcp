/**
 * The `meshcore://help` document — a fuller, pull-on-demand reference for an
 * agent that wants more than the `initialize` instructions. Composed from the
 * same sources those surfaces use (the server instructions + the generated admin
 * catalogue), plus a short recipes section, so it never drifts from the code.
 */
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { commandCatalogue } from "./tools/admin.js";

/** Build the help markdown. Reuses the live admin catalogue (stays in sync). */
export function helpDocument(): string {
  return [
    "# meshcore-mcp",
    "",
    SERVER_INSTRUCTIONS,
    "",
    "## Admin commands",
    "",
    "`admin(node, command, params?, dryRun?)` — preview with `dryRun: true` first; the per-command risk tier is in the result.",
    "",
    commandCatalogue(),
    "",
    "## Recipes",
    "",
    "- **Morning check** — `survey_mesh`, then `get_recent_traffic`, then `get_node_health` on anything quiet or low. (Prompt: `morning-mesh-check`.)",
    "- **Diagnose a quiet node** — `get_node_health <node>`, `get_recent_traffic`, and check last-heard in `survey_mesh`. (Prompt: `diagnose-quiet-node`.)",
    "- **Change a radio safely** — `admin <node> set-radio { freqMhz, bwKhz, sf, cr }` with `dryRun: true` to preview, then for real, then `admin <node> reboot` to apply. Over WiFi your control link survives the change; the LoRa mesh won't until peers match.",
    "- **One node's details** — read the `meshcore://node/<name>` resource (the `{node}` variable autocompletes), or call `get_node_health`.",
  ].join("\n");
}
