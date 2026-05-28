/**
 * Server-level `instructions` — returned in the MCP `initialize` result and read
 * by clients via `getInstructions()`, so an agent gets oriented before its first
 * call. Distilled, high-signal guidance (the agent-useful hints from
 * `docs/guide.md`); keep it short enough to sit in a system prompt.
 */
export const SERVER_INSTRUCTIONS = `meshcore-mcp exposes a MeshCore node — and the mesh reachable through it — as tools, resources, and prompts.

Trust model. This is the device layer and is **ungated**: no action is blocked server-side; you (and any human in the loop) are the policy. Reads are safe; \`send_message\` transmits; \`admin\` can be destructive. Preview an admin command with \`dryRun: true\` before running it, and confirm destructive ones. A wrong \`set-radio\` (applied after a reboot) can drop a node off the mesh.

Surface.
- Reads (read-only, idempotent): \`get_node_health(node?)\` — omit \`node\` for the connected home node, or pass a contact name / hex key prefix for a remote; \`survey_mesh()\` — the roster with last-heard times; \`get_recent_traffic(since?)\` — recent live traffic.
- \`send_message(target, text)\` — \`target\` is a contact (name or hex prefix) or a channel (\`#name\`, \`#index\`). Not idempotent: a resend transmits again.
- \`set_channel(name, secret?, index?)\` / \`delete_channel(index? | name?)\` — manage channels; omit \`secret\` for a random private channel, \`index\` for the next free slot. List channels at \`meshcore://channels\`.
- \`trace_path(path? | node?)\` — trace a route and report each repeater hop's SNR (\`path\` = comma-separated hex hops like \`"23,5f,3a"\`, or a \`node\` to trace its known out-path). A propagation/coverage probe; an unresponsive path returns a timeout.
- \`admin(node, command, params?, dryRun?)\` — one enumerated command; the tool's own description lists the catalogue, each command's accepted param formats, and its risk tier (also returned in the result).
- Resources: \`meshcore://traffic/live\` (subscribable), \`meshcore://nodes\`, \`meshcore://contacts\`, \`meshcore://node/{node}\` (one node's health; the \`{node}\` variable autocompletes), and \`meshcore://help\` (a fuller reference — read it when you want more than this). Prompts: \`morning-mesh-check\`, \`diagnose-quiet-node\`, \`draft-outage-notice\` (the \`node\` argument autocompletes).

Conventions.
- Units: frequency in MHz, bandwidth in kHz (e.g. set-radio 910.525 / 62.5). Numeric params tolerate fuzzy forms but prefer these.
- Provenance: live events carry \`decryptVerified\`. An unverified channel datagram is NOT an authentic channel message — don't trust its content.
- A quiet mesh emits little passively; \`get_recent_traffic\` and the live stream may be empty until an advert or message arrives — that's the radio, not an error.
- Failures come back as actionable \`isError\` results, not exceptions.`;
