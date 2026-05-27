# Guide

Concepts and recipes for `@dpup/meshcore-mcp`. For exhaustive signatures, types,
and exported symbols, see the generated [API reference](./api.md).

## Overview

`meshcore-mcp` is a thin Model Context Protocol server wedged between two
contracts it does **not** own:

- **above — the MCP protocol** (`@modelcontextprotocol/sdk`'s `McpServer`): the
  tools, resources, and prompts an MCP client (Claude Code, say) calls;
- **below — the [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts)
  device client**: one persistent `MeshCoreClient`, with named events, typed
  models, hex-string keys, `Date` timestamps, and typed errors.

```
   MCP client (Claude Code / your agent)
        │  tools · resources · prompts · annotations
        ▼
   meshcore-mcp   server.ts · tools/* · resources/* · prompts/*
        │
   MeshService   (the device-facing core)
        │   injected MeshCoreClient + Clock
        ▼
   @dpup/meshcore-ts  MeshCoreClient
        │
        ▼   raw Connection
   real TCP/serial device   │   SimConnection (@dpup/meshcore-sim, tests/demo)
```

`MeshService` is the device-facing core. It takes its `MeshCoreClient` and a
`Clock` by **injection** — so the same code runs against a real radio in
production and a `@dpup/meshcore-sim` `SimConnection` in tests, and nothing below
`MeshService` can tell which. That seam is what makes the whole server testable
without hardware.

---

## Configuring the home node

`meshcore-mcp` is a **local-process** server (stdio). Its launcher — Claude
Code's MCP config, or your own host — hands it the home node's address and any
credentials through the environment. `loadConfig` reads and validates that
environment, and fails fast with a legible `ConfigError` (it never lets a raw Zod
error escape).

**Transport — required, exactly one:**

- **TCP** (`companion_radio_wifi`): `MESHCORE_HOST`, with optional `MESHCORE_PORT`
  (default `5000`). Becomes `MeshCoreClient.tcp(host, port)`.
- **Serial** (USB): `MESHCORE_SERIAL_PATH` (e.g. `/dev/ttyACM0`). Becomes
  `MeshCoreClient.serial(path)`.

Setting neither, or both, is a `ConfigError`. The `--host` / `--port` / `--serial`
flags override the corresponding env vars.

**Credentials — optional:** `MESHCORE_LOGIN_PASSWORD` is the default login/admin
password (default `""`, the guest password); `MESHCORE_NODE_PASSWORDS` is a JSON
object of per-node overrides, keyed by node id or name:

```json
{ "rocky-ridge": "s3cret", "cedar-creek": "hunter2" }
```

**Tuning — optional:** `MESHCORE_REQUEST_TIMEOUT_MS` (device requests, default
`10000`), `MESHCORE_TRAFFIC_CAPACITY` (recent-traffic ring buffer), and
`MESHCORE_ADMIN_REPLY_TIMEOUT_MS` (how long the remote-admin path waits for a CLI
reply, default `15000`). Each must be a positive integer.

The Claude Code MCP-config entry is the canonical wiring — see the
[README](../README.md#use-it-with-claude-code).

---

## The tool surface

The surface is short and **action-oriented** by design: a handful of well-shaped
tools beats dozens of fine-grained ones, every result is digested, and every
error is actionable rather than a raw frame. Reads are exposed as **read-only
tools** (not only as resources) because tools are what every MCP client reliably
surfaces to the model for active querying.

| Tool | Intent |
| --- | --- |
| `get_node_health(node?)` | A consolidated snapshot — identity, radio, battery, uptime/queue, packet/radio stats. Omit `node` for the home node; pass a contact name or hex key prefix for a remote. It hides the home-vs-remote distinction: a remote read collapses `login → getStatus/getTelemetry` internally. |
| `survey_mesh()` | One roster of the home node and every known contact, with advertised role and last-heard time. |
| `get_recent_traffic(since?)` | Recent live traffic from the rolling buffer, oldest→newest, each tagged with provenance. `since` is ISO-8601 or epoch-ms. |
| `send_message(target, text)` | Transmit to a contact (name or hex prefix) or a channel (`#name`, `#index`, or a bare channel index). |
| `admin(node, command, params?, dryRun?)` | Run one enumerated admin command, home or remote. |

`login` / `logout` are never exposed — they are mechanical, and live inside the
tools that need them (the remote paths of `get_node_health` and `admin`).

### Annotations are the boundary

Every tool carries MCP annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`. These are not decoration: they map onto a
consuming policy layer's command tiers, and they tell any consumer whether a
timed-out call is safe to retry.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| --- | --- | --- | --- |
| `get_node_health` | `true` | `false` | `true` |
| `survey_mesh` | `true` | `false` | `true` |
| `get_recent_traffic` | `true` | `false` | `true` |
| `send_message` | `false` | `false` | **`false`** — a resend is a second transmission |
| `admin` | `false` | **`true`** | `false` (statically conservative) |

`admin`'s static annotations are deliberately conservative — the *set* can be
destructive — but the **per-command** risk tier is carried in the structured
result, so a caller knows the true tier of the specific command it ran.

### Errors are actionable

A device timeout or an unreachable node is **not** a thrown exception — it is an
`isError: true` tool result with a high-signal message
(*"rocky-ridge unreachable: …, last heard 2h ago"*), so the model gets something
it can act on rather than a crash.

---

## The live stream & provenance

The primary resource is the **live inbound event stream**,
`meshcore://traffic/live` — a **subscribable** resource. The server holds the
persistent connection to the home node, buffers each inbound event, and pushes a
`notifications/resources/updated` to any subscriber; the client then re-reads the
resource to fetch the new events. A consumer that must react to traffic
subscribes; a human at Claude Code generally just calls `get_recent_traffic`.

```ts
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { TRAFFIC_LIVE_URI } from "@dpup/meshcore-mcp";

client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
  if (n.params.uri !== TRAFFIC_LIVE_URI) return;
  const fresh = await client.readResource({ uri: TRAFFIC_LIVE_URI });
  // fresh.contents[0] is the recent-events JSON.
});
await client.subscribeResource({ uri: TRAFFIC_LIVE_URI });
```

### Provenance is structural, not a flag

Every event on the stream (and every `get_recent_traffic` row) carries its
**provenance** — a message id, the sender where known, the channel identity, and
critically a **`decryptVerified` boolean**. That boolean is *not* a wire field:
it is derived from **which** `meshcore-ts` event produced the record. The mapping
is fixed and testable:

| `kind` | meshcore-ts event | `decryptVerified` |
| --- | --- | --- |
| `contact` | `contactMessage` (a direct message) | `true` |
| `channel` | `channelMessage` (a decrypt-verified channel message) | `true` |
| `channelData` | `channelData` (a channel datagram, no decoded text) | `false` |
| `advert` | `advert` / `newAdvert` | `false` |
| `raw` | `rawData` / `logRxData` (signal metadata only) | `false` |

This is what makes a downstream gate's **negative cases representable**: an
unverified datagram on an admin channel surfaces only as `channelData` (raw
bytes, no text) and *never* as a verified `channelMessage`, so a gate keyed on
verification correctly rejects it. You cannot safely stage that adversarial input
on real hardware — but a `@dpup/meshcore-sim` scenario produces it on demand.

The roster (`meshcore://nodes`) and contact list (`meshcore://contacts`) are
offered as pull-style resources for clients that prefer to fetch them as context.

---

## The `admin` command set

`admin`'s `command` argument is drawn from an **enumerated, curated set** —
extensible over time, but **never** free-form text. An enumerated set keeps the
surface legible and lets a consuming policy layer map each command to a risk tier
deterministically. The set is a frozen registry (`ADMIN_COMMANDS`); adding a
command is one new entry.

Each command declares a **risk tier**, which maps deterministically to its
annotations (`annotationsForTier`):

| tier | `readOnlyHint` | `destructiveHint` | `idempotentHint` | meaning |
| --- | --- | --- | --- | --- |
| `benign` | `false` | `false` | `false` | transmits / toggles ephemeral state; safe, but an action |
| `config` | `false` | `false` | `true` | a durable, reversible setting change |
| `sensitive` | `false` | **`true`** | `true` | reversible but security-/lockout-relevant; gate like destructive |
| `destructive` | `false` | **`true`** | `false` | reboot / data loss / takes the node offline |

The v1 set (16 commands). **Scope** is `home+remote` (also reachable over the
companion protocol, so the home path uses a structured `MeshCoreClient` method)
or `remote-only` (no companion-protocol equivalent — only the repeater CLI can
express it):

| `command` | params | scope | tier |
| --- | --- | --- | --- |
| `reboot` | — | home+remote | destructive |
| `advert` | `mode?: "flood" \| "zerohop"` | home+remote | benign |
| `sync-time` | — | home+remote | benign |
| `set-tx-power` | `dbm: 1–22` | home+remote | config |
| `set-radio` | `freqMhz, bwKhz, sf: 5–12, cr: 5–8` | home+remote | config |
| `set-name` | `name` (≤32 bytes) | home+remote | config |
| `set-location` | `lat, lon` | home+remote | config |
| `set-admin-password` | `password` (≤15) | remote-only | sensitive |
| `set-repeat` | `enabled: boolean` | remote-only | config |
| `set-dutycycle` | `percent: 1–100` | remote-only | config |
| `log-start` | — | remote-only | benign |
| `log-stop` | — | remote-only | benign |
| `log-erase` | — | remote-only | destructive |
| `clear-stats` | — | remote-only | destructive |
| `remove-neighbor` | `pubKeyPrefix` (hex) | remote-only | destructive |
| `set-permission` | `pubKey` (hex), `level: guest\|read\|readwrite\|admin\|null` | remote-only | sensitive |

### Dispatch

- **Home node** — a direct, structured `MeshCoreClient` method (e.g.
  `reboot()`, `setTxPower(dbm)`). Unambiguous.
- **Remote node** — `login(node, password)` then
  `sendTextMessage(node, cli, TxtType.CliData)`; the repeater's reply returns as
  an ordinary `contactMessage` (txtType `CliData`), correlated by **sender +
  timing** within `adminReplyTimeoutMs`. There is **no explicit logout** in
  meshcore.js 1.13.0 (sessions expire server-side), and **no request/response id**
  on the wire — both are handled by the dispatch, not exposed.

### Dry-run / preview

`admin(node, command, { … }, true)` returns a **synthesized preview** of intent
— a description of what the command *would* do, derived from the enumerated
command's known semantics, **without contacting the device**:

```ts
const preview = await client.callTool({
  name: "admin",
  arguments: { node: "rocky-ridge", command: "reboot", dryRun: true },
});
// → "Reboot rocky-ridge. Unreachable for ~30–60s while it restarts; any session ends."
```

It conveys intent, not a device-validated guarantee — and the result marks it as
a preview, so whoever reads it knows the difference.

---

## The three consumers

`meshcore-mcp` has three consumers. They share one server; they differ only in
how much sits between the device and whoever decides what to do.

- **A human operator, via Claude Code** (or any MCP client). Add the server to
  the MCP config, point it at a node, and operate the mesh in natural language.
  The human is present and approves each tool call — no policy layer is needed;
  the operator *is* the policy.
- **An autonomous agent / bridge on Managed Agents.** A bridge runs
  `meshcore-mcp` as a local subprocess and consumes it as an MCP client, while
  presenting its own gated tools to the cloud agent. The server is never exposed
  to the cloud.
- **An autonomous agent on Hermes.** Hermes consumes `meshcore-mcp` as a local
  `mcp_servers` entry; the policy layer wraps it.

The principle that ties these together: `meshcore-mcp` is the device layer, and
it is **ungated by design**. Whether a policy layer is required is a property of
the *consumer*, not the server. A human at a terminal needs none; an autonomous
agent reading untrusted radio traffic needs the full admin-channel gate and
conversation policy (`meshcore-elmer`). Same server, correct in both cases.

---

## Testing your own agent against a sim-backed server

The cheapest way to test an agent (or any MCP client) against `meshcore-mcp` is
to run the **whole stack in one process, no hardware**: inject a
[`@dpup/meshcore-sim`](https://github.com/dpup/meshcore-sim) `SimConnection`
where production would build `MeshCoreClient.tcp(host, port)`, drive a virtual
`SimClock`, and call tools through a real in-memory MCP `Client`.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import {
  SimClock,
  SimConnection,
  defineWorld,
  node,
  channel,
  contact,
  traffic,
  ChannelKind,
} from "@dpup/meshcore-sim";
import { createServer, MeshService } from "@dpup/meshcore-mcp";

// 1. Author a world that matches what your agent expects.
const world = defineWorld({
  homeNodeId: "home",
  nodes: [
    node("home", { name: "Base" }),
    node("rocky-ridge", { name: "Rocky Ridge", role: "repeater" }),
    node("silent-peak", { name: "Silent Peak", role: "repeater", reachable: false }),
  ],
  channels: [channel(0, "public"), channel(1, "ops", { kind: ChannelKind.Private })],
  contacts: [contact("Rocky Ridge", "rocky-ridge"), contact("Silent Peak", "silent-peak")],
});

// 2. A scenario (here, a burst) plays out on the virtual clock.
const clock = new SimClock();
const sim = new SimConnection({
  world,
  clock,
  scenario: traffic.burst({ from: "rocky-ridge", count: 3, within: "10s" }),
});

// 3. The production seam — a real MeshCoreClient over the sim Connection.
const service = new MeshService(new MeshCoreClient(sim.asConnection(), { autoSync: true }), clock);
await service.start();

// 4. createServer ⟷ in-memory MCP Client — exactly what a real host drives.
const server = createServer({ service });
const client = new Client({ name: "test", version: "0.0.0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

// 5. Read tools return the world's data; an unreachable node fails cleanly.
const survey = await client.callTool({ name: "survey_mesh", arguments: {} });

// 6. Advance the virtual clock to play the burst — no real seconds spent.
clock.advance("10s");
const recent = await client.callTool({ name: "get_recent_traffic", arguments: {} });
```

A few patterns worth knowing:

- **Assert on the tool/resource result**, never on server internals — that proves
  both contracts at once and is the project's centre of gravity.
- **Drive time with the clock, never by sleeping.** `clock.advance("10s")` plays
  a 10-second window instantly and deterministically. To deliver each event near
  its own fire time (so traffic settles before you read it back), advance in
  small slices with a microtask flush between them, rather than one big jump — see
  [`examples/demo.ts`](../examples/demo.ts) for the harness pattern.
- **Provenance / adversarial inputs** — a decrypt-verified channel message vs. an
  unverified admin-channel datagram — are authored with sim scenarios, the inputs
  you cannot safely produce on hardware.
- **`@dpup/meshcore-sim` is a dev/test dependency**, never shipped in production.

---

## See also

- [API reference](./api.md) — every exported symbol with full signatures.
- [`examples/demo.ts`](../examples/demo.ts) — a runnable guided tour covering the
  whole feature set: tools, the live stream with provenance, and `admin` dry-run
  then a scripted exec — sim-backed, no hardware, deterministic.
- [AGENTS.md](../AGENTS.md) — architecture, the two contracts, conventions, and
  the don't-regress list.
