# meshcore-mcp

> A Model Context Protocol server that exposes a [MeshCore](https://meshcore.co.uk)
> node — and the mesh reachable through it — as a clean, high-signal interface
> for any AI agent or tool.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Types: included](https://img.shields.io/badge/types-included-blue.svg)](#)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#)
[![Module: ESM](https://img.shields.io/badge/module-ESM-f7df1e.svg)](#)

**Quick start** — add it to Claude Code pointed at a node, then ask *"survey the mesh"*:

```sh
claude mcp add meshcore --env MESHCORE_HOST=<node-ip> -- npx -y @dpup/meshcore-mcp
```

`meshcore-mcp` wraps a [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts)
`MeshCoreClient` behind a small, deliberately shaped surface of MCP **tools,
resources, and prompts**. Point an MCP client at a node and operate the mesh in
natural language — survey nodes, read recent traffic, send messages, and run
curated admin commands — with structured, digested results instead of raw frames.

It is the **device layer**, and **ungated by design**: no conversation policy,
no admin-channel gate, no coalescing, no autonomous behavior. A human at Claude
Code *is* the policy, and approves each step; an autonomous agent brings its own
(that is `meshcore-elmer`'s job). Same server, correct in both cases — its job is
to be a faithful, well-shaped device interface, and to mark read-versus-action on
every tool so a consuming policy layer, or a reviewing human, can reason about
safety mechanically.

> [!WARNING]
> **The commands are ungated.** `send_message`, `set_channel`, `delete_channel`,
> `trace_path`, and `admin` transmit on the mesh and change device state with **no
> built-in approval or policy layer** of their own. With **Claude Code** you
> approve every tool call — that human-in-the-loop *is* the gate, and what makes
> interactive use safe. For **autonomous or headless** use, put your own policy
> layer in front (that is `meshcore-elmer`'s job) — don't point an unattended
> agent at a live mesh without one. Every tool is annotated read-only vs. action
> (`readOnlyHint` / `destructiveHint`) so a policy layer, or a reviewing human,
> can reason about safety mechanically.

## Use it with Claude Code

`meshcore-mcp` is a local-process server (stdio). The simplest consumer is a
human operator with Claude Code: add one entry to your MCP configuration,
pointing it at a node, and operate the mesh in plain language — Claude Code
prompts before every tool call, so no policy layer is needed (see the warning
above).

**Pick the config that matches how your node is flashed.** A MeshCore node runs
*either* a WiFi companion firmware (`companion_radio_wifi`, reached over TCP/IP)
*or* a USB/serial companion firmware — one transport per build. Set the matching
variable; setting both is rejected at startup with a legible error.

**WiFi / IP companion** — point it at the node's address (default port `5000`):

```json
{
  "mcpServers": {
    "meshcore": {
      "command": "npx",
      "args": ["-y", "@dpup/meshcore-mcp"],
      "env": {
        "MESHCORE_HOST": "192.168.1.50",
        "MESHCORE_PORT": "5000"
      }
    }
  }
}
```

**USB / serial companion** — point it at the device path (`/dev/ttyACM0` on
Linux, `/dev/tty.usbmodemXXXX` on macOS, `COM3` on Windows):

```json
{
  "mcpServers": {
    "meshcore": {
      "command": "npx",
      "args": ["-y", "@dpup/meshcore-mcp"],
      "env": {
        "MESHCORE_SERIAL_PATH": "/dev/ttyACM0"
      }
    }
  }
}
```

> Serial needs Node's native `serialport` bindings — the published `npx` / binary
> path runs on Node, so this just works (the `bun` dev entrypoint can't load the
> serial native module).

The server reads its home node and credentials from the environment its launcher
hands it; a malformed or missing config exits non-zero with a legible message
(never a stack trace).

| Variable | Meaning |
| --- | --- |
| `MESHCORE_HOST` | Home node TCP host — the `companion_radio_wifi` path. Set this **or** `MESHCORE_SERIAL_PATH`, not both. |
| `MESHCORE_PORT` | TCP port for `MESHCORE_HOST` (default `5000`). |
| `MESHCORE_SERIAL_PATH` | USB serial device path (e.g. `/dev/ttyACM0`) — the serial alternative to `MESHCORE_HOST`. |
| `MESHCORE_LOGIN_PASSWORD` | Default login/admin password for remote nodes (default `""` — the guest password). |
| `MESHCORE_NODE_PASSWORDS` | JSON object of per-node overrides: `{ "rocky-ridge": "secret" }` (keyed by node id or name). |
| `MESHCORE_REQUEST_TIMEOUT_MS` | Device request timeout, ms (default `10000`). |
| `MESHCORE_TRAFFIC_CAPACITY` | Recent-traffic ring-buffer size (default the buffer's own default). |
| `MESHCORE_ADMIN_REPLY_TIMEOUT_MS` | How long the remote-admin path waits for a CLI reply, ms (default `15000`). |

The `--host`, `--port`, and `--serial` flags override the corresponding env vars.

### Try it with no radio (simulator)

No MeshCore hardware? [`examples/sim-server.ts`](./examples/sim-server.ts) serves
the exact same MCP surface over stdio, but backed by
[`@dpup/meshcore-sim`](https://github.com/dpup/meshcore-sim) over a small
simulated mesh — with a real-time clock so live traffic actually flows while you
poke at it. Point Claude Code at it:

```sh
git clone https://github.com/dpup/meshcore-mcp && cd meshcore-mcp && bun install
claude mcp add meshcore-sim -- bun "$(pwd)/examples/sim-server.ts"
```

Then ask Claude to *"survey the mesh"*, *"check the health of Rocky Ridge"*,
*"show recent traffic"*, or *"preview an admin reboot of Rocky Ridge"*. The
production binary (`src/cli.ts`) talks only to real devices; the simulator is a
dev dependency and never ships — this entrypoint is the hardware-free way to try
the server. Remote `admin` execution round-trips too: the sim-server configures
reactive responders (meshcore-sim ≥ 0.2.0), so `login → CliData → reply` returns
a plausible CLI reply instead of timing out.

## The surface

A short, action-oriented surface: a handful of well-shaped tools beats dozens of
fine-grained ones. Reads are exposed as **read-only tools** (not only as
resources) because tools are what every MCP client reliably surfaces to the model
for active querying. The `login` / `logout` handshake is never exposed — it is
mechanical, and lives inside the tools that need it.

### Tools

| Tool | Intent | Annotations |
| --- | --- | --- |
| `get_node_health(node?)` | Consolidated health snapshot — identity, radio, battery, uptime/queue, packet/radio stats. Omit `node` for the home node; pass a contact name or hex key prefix for a remote. Hides the home-vs-remote distinction and any remote login. | read-only · idempotent |
| `survey_mesh()` | One roster of the home node and every known contact, with advertised role and last-heard time — for spotting quiet or missing nodes. | read-only · idempotent |
| `get_recent_traffic(since?)` | Recent live mesh traffic from the rolling buffer, oldest→newest, each tagged with structural provenance. `since` (ISO-8601 or epoch-ms) windows it. | read-only · idempotent |
| `send_message(target, text)` | Transmit a message to a contact (name / hex prefix) or channel (`#name`, `#index`, or a bare index). | action · **not idempotent** — a resend is a second transmission |
| `admin(node, command, params?, dryRun?)` | Run one enumerated admin command against a node, home or remote; collapses the remote `login → CliData → reply` handshake. `dryRun: true` previews the intent without contacting the device. | **destructive** (statically conservative); per-command risk tier in the result |

`admin`'s `command` is drawn from an **enumerated, curated set** of 16 commands —
see the [guide](./docs/guide.md#the-admin-command-set) — extensible, but never
free-form text. Each command declares a **risk tier** (`benign` · `config` ·
`sensitive` · `destructive`) that maps deterministically to per-command
annotations, surfaced in the structured result.

### Resources

| Resource | URI | Notes |
| --- | --- | --- |
| Live mesh traffic | `meshcore://traffic/live` | **Subscribable.** A rolling feed of inbound events; the server pushes `notifications/resources/updated` to subscribers, who then re-read to fetch. Every event carries provenance — sender, channel identity, and **decrypt-verification**. |
| Mesh roster | `meshcore://nodes` | Pull-style: the home device plus every known contact, each with role and last-heard time. |
| Contacts | `meshcore://contacts` | Pull-style: the home node's stored contact list — name, public key, role, location, last-heard. |

Decrypt-verification is **structural**, not a wire flag: `meshcore-ts`
distinguishes a verified `channelMessage` from an unverified `channelData`
datagram (and a direct `contactMessage` from either), and the stream preserves
that distinction. That is exactly what lets a downstream gate's negative cases be
representable — an unverified admin-channel datagram never surfaces as a verified
channel message.

### Prompts

| Prompt | Args | Frames |
| --- | --- | --- |
| `morning-mesh-check` | — | A daily health sweep: survey the roster, flag quiet nodes, spot-check the suspicious ones. |
| `diagnose-quiet-node` | `node` | Work out why a node has gone quiet — health, recent traffic, last-heard, context. |
| `draft-outage-notice` | `node`, `window?` | Draft a concise outage notice over a time window, and send it on approval. |

A prompt **frames; it does not freeze**: each poses a well-formed task and points
the agent at the real tools by name, and the agent still reasons freely. No
policy, no secrets.

## Install

```sh
npm install @dpup/meshcore-mcp      # or: bun add @dpup/meshcore-mcp / pnpm add @dpup/meshcore-mcp
```

ESM-only, **Node.js ≥ 18**. Most users won't install it directly — they point
Claude Code's MCP config at `npx @dpup/meshcore-mcp` (above). Install it as a
dependency when you embed `createServer` in your own host.

## Documentation

- **[Guide](./docs/guide.md)** — concepts and recipes: configuring the home node,
  the tool surface and annotations, the live stream and provenance, the `admin`
  set and dry-run, the three consumers, and testing your own agent against a
  sim-backed server.
- **[API reference](./docs/api.md)** — the complete, generated reference: every
  exported symbol, with full signatures and types.

## Quickstart — embed a sim-backed server

You can drive the whole server in-process with **no hardware**, against
[`@dpup/meshcore-sim`](https://github.com/dpup/meshcore-sim): inject a
`SimConnection` where production would build `MeshCoreClient.tcp(host, port)`,
drive a virtual `SimClock`, and call tools through a real in-memory MCP `Client`.
Nothing below `MeshService` can tell a sim from a radio — this is the seam the
whole test strategy hangs on.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import { SimClock, SimConnection, defineWorld, node, contact } from "@dpup/meshcore-sim";
import { createServer, MeshService } from "@dpup/meshcore-mcp";

// 1. A simulated mesh — no radio. The home node plus one contact.
const world = defineWorld({
  homeNodeId: "home",
  nodes: [node("home", { name: "Base" }), node("alice", { name: "Alice" })],
  contacts: [contact("Alice", "alice")],
});

// 2. The injected clock the whole server takes its time from.
const clock = new SimClock();

// 3. A real MeshCoreClient over the sim Connection — the production seam.
const meshClient = new MeshCoreClient(new SimConnection({ world, clock }).asConnection(), {
  autoSync: true,
});
const service = new MeshService(meshClient, clock);
await service.start();

// 4. Wire createServer to an in-memory MCP Client (no sockets, no stdio).
const server = createServer({ service });
const client = new Client({ name: "demo", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

// 5. Call a tool exactly as Claude Code would.
const health = await client.callTool({ name: "get_node_health", arguments: {} });
console.log(health.structuredContent);

await client.close();
await server.close();
await service.stop();
```

In production, `cli.ts` does the same wiring over `MeshCoreClient.tcp(host, port)`
and a `SystemClock`, served on a `StdioServerTransport` — that's what the
`meshcore-mcp` binary (and the Claude Code config above) launches.

## See it in action

[`examples/demo.ts`](examples/demo.ts) is a guided tour — it builds a world,
drives the real server through an in-memory MCP `Client`, and walks the whole
feature set: tools (home + an offline repeater failing cleanly), the live stream
with verified vs. unverified provenance side by side, and an `admin` dry-run
preview then a scripted exec. No hardware, fully deterministic:

```sh
bun examples/demo.ts          # or --seed <n> / a positional seed
```

> In a real terminal the tour is ANSI-colored; re-run it with any `--seed` and
> the output is identical every time.

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit (strict)
bun run test        # vitest — incl. full-stack tests over a sim-backed server
bun run build       # emit dist/ (ESM + .d.ts + the meshcore-mcp binary)
bun run dev         # run the server over stdio
bun run docs        # regenerate docs/api.md from the source
```

See [AGENTS.md](./AGENTS.md) for architecture and contribution notes.

## Design notes

- **Two contracts, one server.** `meshcore-mcp` is a thin server wedged between
  the **MCP protocol** above (`@modelcontextprotocol/sdk`'s `McpServer`) and the
  **`@dpup/meshcore-ts` device client** below. It owns neither. Almost every
  design decision falls out of taking both seriously.
- **Injected client + clock.** `MeshService` takes its `MeshCoreClient` and
  `Clock` by **injection** — production builds `MeshCoreClient.tcp(host, port)`
  with a `SystemClock`; tests build `new MeshCoreClient(sim.asConnection())` with
  a `SimClock`. Nothing below `MeshService` knows which it got, and time always
  comes from the clock — never raw `Date.now()` / `setTimeout`.
- **Provenance is a hard requirement.** The live stream carries each event's
  sender, channel identity, and structural decrypt-verification, because a
  downstream policy layer can only function if it knows which channel a message
  genuinely arrived on.
- **Ungated by design.** No policy, no admin-channel gate, no scheduling, no
  autonomous behavior. That belongs to a consumer; keeping the server free of it
  is exactly what lets the same artifact serve a human at a terminal and an
  autonomous agent without compromise.

## License

[MIT](./LICENSE) © Dan Pupius
