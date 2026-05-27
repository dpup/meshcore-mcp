# meshcore-mcp — A MeshCore interface for AI agents

**Spec · v0.3 · Draft**

## 1. What it is

`meshcore-mcp` is a Model Context Protocol server that exposes a MeshCore node —
and the nodes reachable through it — as a clean, high-signal interface that any
MCP-speaking agent or tool can use. It wraps the MeshCore device library behind a
small, deliberately shaped surface of tools and resources.

It is a **standalone component**. There is no good MeshCore MCP server off the
shelf; this is one, built well enough to be worth open-sourcing to the MeshCore
community.

It is the device layer for the `meshcore-elmer` agent (see the meshcore-elmer design doc),
but it is not specific to meshcore-elmer — and its first, simplest user is a human
operator with Claude Code.

## 2. Consumers and trust models

`meshcore-mcp` has three consumers. They share one server; they differ only in
how much sits between the device and whoever is deciding what to do.

- **A human operator, via Claude Code** (or any MCP client). Add the server to
  Claude Code's MCP configuration, point it at a node, and operate the mesh in
  natural language. The human is present and approves each action — Claude Code
  prompts before every tool call. No policy layer is needed; the operator *is*
  the policy.
- **`meshcore-elmer` on Claude Managed Agents.** The meshcore-elmer bridge runs
  `meshcore-mcp` as a local subprocess and consumes it as an MCP client, while
  presenting its own gated tools to the cloud agent. The server is never exposed
  to Anthropic's cloud.
- **`meshcore-elmer` on Hermes Agent.** Hermes consumes `meshcore-mcp` as a local
  `mcp_servers` entry; meshcore-elmer's transport adapter and policy layer wrap it.

The principle that ties these together: **`meshcore-mcp` is the device layer,
and it is ungated by design.** Whether a policy layer is required is a property
of the *consumer*, not the server. A human at a terminal approving each step
needs none — exactly as `meshcore-cli` needs none, because you typed the
command. An autonomous agent reading untrusted radio traffic needs meshcore-elmer's
full admin-channel gate and conversation policy. Same server, correct in both
cases. The server's job is to be a faithful, well-shaped device interface;
deciding *whether an action is allowed* belongs to whoever is driving.

## 3. Why it beats the CLI

`meshcore-cli` is a control surface: you issue commands you already know, one at
a time, and read raw output. `meshcore-mcp` plus an agent turns the network into
something **queryable and composable**:

- You state intent in natural language; the agent selects and sequences the calls.
- The agent chains and correlates — "which of my nodes haven't been heard from
  today?" becomes a survey, a filter, and a summary, not a series of commands you
  run and eyeball.
- Results are structured and high-signal; the agent digests them into an answer
  instead of leaving you to parse frames.
- Live state and recent traffic are available for the agent to reason over.

This does not replace the CLI's scripting role. It is a better surface for
*interactive operation and diagnosis* — the work an operator does by hand today.

## 4. Design principles

- **Action-oriented surface.** Tools are shaped around operator intent, not the
  device's raw verbs.
- **Collapse mechanical sequences; never bake in judgment.** Multi-step plumbing
  with no branching — the remote-admin login / command / teardown handshake,
  aggregating several stat reads into one snapshot — is hidden inside single
  tools. Decision workflows ("diagnose why a node isn't relaying") are *not* —
  that is the agent's reasoning, and freezing it into the server would rebuild a
  fixed-script bot one layer down.
- **Minimal and high-signal.** A handful of well-shaped tools beats dozens of
  fine-grained ones. Every result is digested; every error is actionable.
- **The annotation is the boundary.** Read versus action is marked by tool
  annotations (below), not left implicit — so a consuming policy layer, or a
  reviewing human, can reason about safety mechanically.

## 5. Interface

### 5.1 Tools

| Tool | Intent | Annotations |
|---|---|---|
| `get_node_health(node)` | Consolidated health and configuration snapshot — battery, radio/packet stats, device time, current radio config — for the home node or any reachable node. Hides the home-vs-remote distinction and any remote login. | read-only, idempotent |
| `survey_mesh()` | One consolidated view of all known nodes and contacts, with last-heard times. | read-only, idempotent |
| `get_recent_traffic(since)` | Recent messages and adverts observed by the node, since a given time. | read-only, idempotent |
| `send_message(target, text)` | Transmit a message to a contact or channel. | not read-only; **not idempotent** — a resend is a second transmission |
| `admin(node, command)` | Run an administrative command on a node, home or remote; collapses the login / command / teardown handshake when the target is remote. | **destructive** (varies by command); not idempotent |

The list is intentionally short. `login` / `logout` are not exposed — they are
mechanical and live inside the tools that need them. Reads are exposed as
**read-only tools**, not only as resources, because tools are what every MCP
client reliably surfaces to the model for active querying; the `readOnlyHint`
annotation is what keeps the surface action-oriented in spirit.

The `admin` `command` argument is drawn from an **enumerated, curated set** of
supported operations — extensible over time, but not free-form text. An
enumerated set keeps the surface legible and lets a consuming policy layer map
each command to a risk tier deterministically (meshcore-elmer's §8.5 tiers).

### 5.2 Resources

The primary resource is the **live inbound event stream**,
`meshcore://traffic/live` — a subscribable resource. The server holds the
persistent connection to the home node and emits inbound mesh events as
notifications. Consumers that must react to traffic — meshcore-elmer's coalescer —
subscribe; a human at Claude Code generally does not.

Each event on this stream **must carry its provenance** — message id, sender,
and, critically, **channel identity and decrypt-verification status**. A
downstream policy layer (meshcore-elmer's admin-channel gate) can only function if it
knows which channel a message genuinely arrived on; this provenance is a hard
requirement of the stream, not optional metadata. Decrypt-verification is
**structural**, not a wire flag: `meshcore-ts` distinguishes a verified channel
message from an unverified channel datagram (and a direct contact message from
either), and the stream preserves that distinction — which is exactly what makes
the gate's negative cases representable.

The mesh roster (`meshcore://nodes`) and contact list (`meshcore://contacts`)
are also offered as resources, for clients that prefer to pull them as context.

### 5.3 Annotations, output, and errors

Every tool carries MCP annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint`. These are not decoration: they map directly onto meshcore-elmer's
command tiers and gating, and they tell any consumer whether a timed-out call is
safe to retry — for `send_message`, it is not.

Tool results are structured, typed values. Errors are high-signal and
actionable — *"rocky-ridge unreachable: no ACK after 3 attempts, last heard
2h ago"*, not a raw exception.

`admin` supports a **dry-run / preview** mode, which pairs with meshcore-elmer's
confirmation flow. MeshCore's admin protocol likely has no native no-op preview,
so the preview is **synthesized server-side** — a description of what the command
*would* do, derived from the enumerated command's known semantics, without
contacting the device. It conveys intent (*"this would reboot rocky-ridge; the
node will be unreachable for ~60s"*), not a device-validated guarantee — and the
distinction should be clear to whoever reads it.

### 5.4 Prompt templates

MCP servers can also expose **prompt templates** — parameterized starting prompts
a client surfaces to its user. `meshcore-mcp` should offer a small, curated set.
This spec does not enumerate them — that is content, and it will evolve — but
gives principles for an implementor:

- **They serve the human-operator consumer.** Prompt templates are for the Claude
  Code use case — pre-built starting points that encode operator know-how (a
  morning mesh check, diagnosing a quiet node, drafting an outage notice).
  meshcore-elmer's autonomous consumers bring their own prompting and can ignore them.
- **A prompt frames; it does not freeze.** This is where workflow knowledge
  legitimately lives. §4 keeps judgment workflows *out* of the tools — a
  `diagnose_node` tool would hard-code reasoning. A prompt template carries the
  same diagnostic know-how as *framing*: it poses a well-formed task and points
  at the right tools, and the agent still reasons freely. Framing, not control
  flow.
- **Shape them around recurring operator intent**, and parameterize them (node
  id, time window) so they are reusable.
- **They compose with tools and resources — they do not duplicate them.** A
  template directs the agent to existing tools; it never re-implements device
  logic.
- **No policy, no secrets.** A prompt template is content, not authority — the
  same boundary that applies everywhere else.
- **Few and high-signal.** A handful of well-shaped templates, curated, beats an
  exhaustive list.

## 6. Configuration and deployment

`meshcore-mcp` is a **local-process** MCP server (stdio, or local HTTP). It is
not designed to be exposed publicly — for the Managed Agents case in particular,
the meshcore-elmer bridge consumes it locally and the server is never reachable from
the cloud.

It needs: the home node's address (TCP host and port for `companion_radio_wifi`)
and — for remote administration — the relevant node admin credentials and
channel keys.

Wiring per consumer:

- **Claude Code** — one entry in the MCP configuration, pointing at the node.
  Nothing else.
- **meshcore-elmer / Managed Agents** — the bridge launches it as a local subprocess.
- **meshcore-elmer / Hermes** — an `mcp_servers` entry.

`meshcore-mcp` is implemented in **TypeScript**, built on
[`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts) — the typed, ergonomic
wrapper over `@liamcottle/meshcore.js`. The earlier open question of whether to
factor that typed wrapper as its own package is settled: it exists, as its own
package, and `meshcore-mcp` depends on it. The server talks to `meshcore-ts`'s
`MeshCoreClient` — named events, typed models, hex-string keys, `Date`
timestamps, typed errors — and never wrangles raw byte codes. Because the server
is a separate process, this is decoupled from any consumer's language —
including the Hermes (Python) path, which consumes it over MCP regardless.

Testing and demos run **without a radio**, on
[`@dpup/meshcore-sim`](https://github.com/dpup/meshcore-sim) — a deterministic,
behavioral MeshCore simulator by the same author. Its `SimConnection` is a
drop-in for a real connection (`new MeshCoreClient(sim.asConnection())`) and its
`SimClock` drives time, so the whole server is exercised end to end — reads,
sends, the live stream, and the admin-channel negative cases the provenance
requirement exists for — deterministically, in CI, with no hardware. `meshcore-sim`
is a dev/test dependency, never shipped. Correspondingly, it is a design rule
that `meshcore-mcp` take its time from an **injected clock** (a `now()` plus
timer scheduling), never raw `Date.now()` / `setTimeout`: a real clock in
production, `SimClock` in tests.

## 7. What it is not

`meshcore-mcp` is the device, exposed well. It contains no conversation policy,
no admin-channel gate, no coalescing, no scheduling, no autonomous behavior. That
logic belongs to `meshcore-elmer`, and only autonomous consumers need it. Keeping the
server free of it is exactly what lets the same artifact serve a human at a
terminal and an autonomous agent without compromise.

## 8. Decisions and remaining questions

Resolved — reflected in the sections above:

- **Language & device binding.** TypeScript, built on `@dpup/meshcore-ts` — the
  typed wrapper over `@liamcottle/meshcore.js`, now its own package (§6). This
  also settles the old "factor the wrapper as its own package?" question: it is
  factored, and we depend on it.
- **Inbound provenance.** Per-message channel identity and decrypt-verification
  are a hard requirement of the live-traffic stream (§5.2), and they are
  *satisfiable*: `meshcore-ts` already expresses decrypt-verification structurally
  (`contactMessage` / `channelMessage` / `channelData`), so the wrapper surfaces
  the distinction the stream must carry.
- **Testing without hardware.** `@dpup/meshcore-sim` (a dev/test dependency)
  drives the whole server deterministically — including the admin-channel
  negative cases that cannot be staged on real hardware (§6).
- **`admin` dry-run.** MeshCore likely has no native no-op preview; the dry-run
  is a server-synthesized preview of intent (§5.3).
- **`admin` command argument.** An enumerated, curated set — extensible, not
  frozen (§5.1).
- **Remote-admin transport.** Confirmed available through `meshcore-ts` (verified
  against meshcore.js, `meshcore_py`, and `meshcore-cli`): a remote admin command
  is `login()` followed by `sendTextMessage(node, cmd, TxtType.CliData)`, with the
  reply arriving as a `CliData` `contactMessage` (§5.1). Two nuances the
  implementation handles, documented in the execution plan: meshcore.js 1.13.0
  exposes no explicit *logout* (sessions expire server-side, so teardown is
  implicit), and CLI replies carry no request id (correlate by sender + timing).

- **Initial `admin` command set.** Pinned down — a curated 16-command subset of
  MeshCore's repeater CLI, with parameters, scope (home+remote vs remote-only),
  risk tier, and a synthesized preview for each (execution plan §9). The wire
  accepts arbitrary CLI text; the enumerated set is `meshcore-mcp`'s curation on
  top, and is intentionally extensible.

Remaining: none blocking — the v0.3 decisions plus the execution plan close the
open items. The enumerated `admin` set (execution plan §9) is deliberately a
starting point, grown one command at a time as operator need arises.