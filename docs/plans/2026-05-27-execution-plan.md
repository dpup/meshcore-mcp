# meshcore-mcp — Execution Plan

**Derived from:** [`2026-05-26-initial-prd.md`](./2026-05-26-initial-prd.md) (Spec v0.3)
**Status:** Ready to build
**Target package:** `@dpup/meshcore-mcp`

This turns the PRD into a buildable sequence. It locks the two technical
contracts `meshcore-mcp` sits between — the **MCP protocol** above and the
**`@dpup/meshcore-ts` device client** below — mirrors the stack and conventions
of [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts) and
[`@dpup/meshcore-sim`](https://github.com/dpup/meshcore-sim) so all three read as
one author's work, and breaks the work into checkpointed milestones with a
self-contained, sim-backed demo as the headline acceptance test.

---

## 1. The central bridge: two contracts, one server

`meshcore-mcp` is a thin server wedged between two contracts it does **not** own.
Almost every design decision falls out of taking both seriously.

```
   MCP client (Claude Code / meshcore-elmer)
        │  MCP protocol  (tools · resources · prompts · annotations)
        ▼
   ┌─────────────────────── meshcore-mcp ───────────────────────┐
   │  server.ts   tools/*   resources/*   prompts/*             │
   │                    │                                       │
   │              MeshService  (the device-facing core)         │
   │                    │   injected MeshCoreClient + Clock      │
   └────────────────────┼──────────────────────────────────────┘
                        ▼
         @dpup/meshcore-ts  MeshCoreClient   (named events, typed models)
                        │
                        ▼   raw Connection
        real TCP/serial device     │     SimConnection  (@dpup/meshcore-sim, tests/demo)
```

### Contract below — `@dpup/meshcore-ts` (resolves PRD §6, §8)

The server never touches `@liamcottle/meshcore.js` directly. It holds **one
persistent `MeshCoreClient`** (`autoSync: true`) and consumes its *normalized*
surface: named events (`contactMessage`, `channelMessage`, `channelData`,
`advert`, `newAdvert`, `pathUpdated`, …), typed models (`Contact`, `SelfInfo`,
`RepeaterStats`, `Telemetry`, `Channel`, …), hex-string keys, `Date` timestamps,
and typed errors (`MeshCoreError` / `…DeviceError` / `…TimeoutError`).

The single most important integration fact, found by reading both libraries:

> `MeshCoreClient`'s constructor is **public** and takes a raw `Connection`:
> `new MeshCoreClient(connection, options)`. `@dpup/meshcore-sim`'s
> `SimConnection` is a drop-in for that connection —
> `new MeshCoreClient(sim.asConnection(), opts)` — backed by a simulated world
> and a `SimClock`.

So **`MeshService` must accept its `MeshCoreClient` (or the connection) by
injection.** In production the entrypoint builds `MeshCoreClient.tcp(host, port)`;
in tests it builds `new MeshCoreClient(sim.asConnection())`. Nothing below
`MeshService` knows which it got. This is the seam the whole test strategy hangs
on (§5).

### Contract above — the Model Context Protocol

Use the official TypeScript SDK, **`@modelcontextprotocol/sdk`**, and its
high-level `McpServer`:

- **Tools** via `server.registerTool(name, { title, description, inputSchema,
  outputSchema, annotations }, handler)`. Inputs/outputs are **Zod** schemas;
  the SDK derives JSON Schema and validates. Annotations carry
  `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
  (PRD §5.3 — "the annotation is the boundary").
- **Resources** via `server.registerResource(...)`, including a **subscribable**
  resource for the live stream; the server pushes
  `notifications/resources/updated` and the SDK fans them out to subscribers.
- **Prompts** via `server.registerPrompt(...)` — the curated templates (PRD §5.4).
- **Transport:** `StdioServerTransport` for v1 (the local-process model, PRD §6).
  Streamable-HTTP is a later option (§8 out-of-scope).

The SDK ships an **in-memory transport pair** (`InMemoryTransport.createLinkedPair()`)
that links a `Client` to a `Server` in one process with no I/O. That is the top
of the test stack (§5).

### The full-stack test seam (the de-risking insight)

Both contracts are exercised at once, in one process, no hardware, no sockets:

```
MCP Client ⟷ InMemoryTransport ⟷ McpServer[meshcore-mcp]
                                      → MeshService
                                        → MeshCoreClient (@dpup/meshcore-ts)
                                          → SimConnection (@dpup/meshcore-sim)
                                            → simulated world + SimClock
```

A test calls a tool through a real MCP `Client`, the server runs a real
`MeshCoreClient`, the sim answers, the clock is advanced, and the test asserts on
the **tool's structured result** — never on server internals. This single
end-to-end path proves both contracts simultaneously and is the project's centre
of gravity, exactly as "a real `MeshCoreClient` over `SimConnection`" was for
meshcore-sim.

### Provenance mapping (PRD §5.2) onto meshcore-ts events

The live stream must carry channel identity + decrypt-verification. meshcore-ts
expresses verification **structurally**, and meshcore-sim produces each case on
demand — so the mapping is fixed and testable:

| PRD stream concept | meshcore-ts event | sim authoring |
|---|---|---|
| Direct message from a contact | `contactMessage` (`pubKeyPrefix`, `text`, `senderTimestamp`) | `scenario` message event keyed to a contact |
| Channel message, **decrypt-verified** | `channelMessage` (`channelIdx`, `text`) | `ChannelMessageEvent` on a channel the world holds the key for |
| Channel traffic **not** verified | `channelData` / `rawData` (`snr`, `channelIdx`, bytes, **no decoded text**) | datagram event with no verified key |
| Admin-gate negative case | a `channelData`/`rawData` tagged with the admin channel idx that **never** surfaces as a `channelMessage` | datagram on the admin channel idx, unverified |

Each live-stream event the server emits carries: message id (server-assigned),
sender (`pubKeyPrefix` where known), channel identity (`channelIdx` / name),
**decrypt-verified boolean** (derived from *which* event fired), `rssi`/`snr`
where present, and the injected-clock timestamp. This table is the contract for
the §2 / §5.2 admin-gate cases and is validated in **M4**.

### Dependency graph

- **`@modelcontextprotocol/sdk`** — runtime dependency. The MCP server framework.
- **`@dpup/meshcore-ts`** — runtime dependency. The device client and all device
  types. Pin `^0.1.1`.
- **`zod`** — runtime dependency (tool/resource schema definitions; SDK peer).
- **`@dpup/meshcore-sim`** — **dev** dependency only (tests + the demo); never
  shipped. Pin `^0.1.1`.
- **`@liamcottle/meshcore.js`** — **dev** dependency only, to satisfy meshcore-sim's
  peer (it produces raw shapes). `meshcore-mcp`'s own code never imports it.
- `meshcore-mcp` **never** depends on `meshcore-elmer` (PRD §7) — the policy layer
  consumes the server, not the reverse.

---

## 2. Stack & conventions (mirror meshcore-ts / meshcore-sim exactly)

Same toolchain, same idioms — a reader should not be able to tell the three repos
apart by their scaffolding.

- **Language/module:** TypeScript, ESM-only, `type: module`. `tsconfig` with
  `target/lib ES2022`, `module/moduleResolution NodeNext`, `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `declaration` + `declarationMap` + `sourceMap`, `skipLibCheck`. Node ≥ 18
  (CI/release on 24).
- **Imports:** `.js` extensions on relative imports; split `import type` /
  `export type` (verbatim module syntax).
- **Runner/build:** `bun` (≥ 1.2 — text `bun.lock`) for install/scripts;
  `tsc -p tsconfig.build.json` emits `dist/` (`rootDir: src`, excludes
  test/examples). `vitest` for tests.
- **Scripts** (copy from meshcore-sim, adjust): `build`, `clean`, `typecheck`,
  `test`, `test:watch`, `docs`, `docs:check`, `prepublishOnly`. **Plus** `start`
  / `dev` to run the server locally over stdio.
- **Docs:** three layers — `README.md` (landing), `docs/guide.md` (hand-written
  recipes), `docs/api.md` (**generated** by TypeDoc + `scripts/postdocs.mjs`,
  CI-gated by `scripts/docs-check.mjs`), plus `llms.txt` indexing all three.
- **Agent docs:** `AGENTS.md` (full) + `CLAUDE.md` (TL;DR pointing at it), same
  voice — architecture, conventions, a "don't-regress" list.
- **CI/release:** `.github/workflows/ci.yml` (typecheck/test/build/docs:check on
  bun) and `release.yml` (tag-driven, npm Trusted Publishing / OIDC + provenance).
  License MIT © Dan Pupius.
- **moat.yaml:** the repo's `moat.yaml` currently still reads `name: meshcore-sim`
  — **rename to `meshcore-mcp`** in M0; otherwise it already pins the right
  toolchain and grants.

### What's *different* here from the two libraries

`meshcore-mcp` is an **executable server**, not just a library. Two consequences:

- **A `bin` entry.** `package.json` gets `"bin": { "meshcore-mcp": "dist/cli.js" }`
  and `dist/cli.js` carries a `#!/usr/bin/env node` shebang (preserved by tsc —
  it lives in `src/cli.ts`). This is what lets a user add the server to Claude
  Code's MCP config or run it via `npx @dpup/meshcore-mcp`.
- **No `meshcore.d.ts` shim / `postbuild.mjs`.** Like meshcore-sim, we re-export
  no raw `@liamcottle/meshcore.js` classes — all device types come *through*
  `@dpup/meshcore-ts`, which ships its own types. So a consumer of our `dist/`
  should not hit `TS7016`. Verify with the meshcore-ts probe (compile a throwaway
  consumer against `dist/`); add a shim step only if it fails. It should not.

---

## 3. Repository scaffold

```
meshcore-mcp/
  package.json            name @dpup/meshcore-mcp; bin; deps as §1; scripts as §2
  tsconfig.json           mirror meshcore-sim
  tsconfig.build.json     mirror
  vitest.config.ts        mirror
  typedoc.json            mirror (entry src/index.ts)
  moat.yaml               (rename name -> meshcore-mcp)
  README.md  AGENTS.md  CLAUDE.md  llms.txt  LICENSE
  .gitignore  .github/workflows/{ci,release}.yml
  scripts/{postdocs.mjs, docs-check.mjs}
  src/
    index.ts              library surface (re-exports createServer, MeshService, types)
    cli.ts                #! entrypoint: read config, build MeshCoreClient, start stdio server
    server.ts             createServer(service): wires tools + resources + prompts onto McpServer
    config.ts             env/flags -> Config (host, port, transport, credentials, channel keys)
    clock.ts              Clock interface (now + timer scheduling) + SystemClock (prod impl)
    service/
      mesh-service.ts     MeshService — the device-facing core (DI'd client + clock + buffer)
      traffic-buffer.ts   ring buffer of recent live events, with provenance + timestamps
      health.ts           consolidated health snapshot (home + remote) assembler
      admin.ts            enumerated admin command set: schema, risk tier, dry-run preview, exec
    tools/
      get-node-health.ts  survey-mesh.ts  get-recent-traffic.ts
      send-message.ts     admin.ts        (one registrar per tool)
    resources/
      traffic-live.ts     nodes.ts  contacts.ts
    prompts/
      index.ts            curated prompt templates (morning check, diagnose quiet node, outage notice)
    errors.ts             McpToolError -> actionable, high-signal tool error results
    format.ts             model -> structured tool-output shaping (digest, not raw frames)
  test/
    server.tools.read.test.ts      full-stack: Client -> server -> sim, read tools
    server.tools.action.test.ts    send_message, admin (incl. dry-run)
    server.resources.test.ts       nodes/contacts + live subscribe/notify
    provenance.test.ts             verified vs unverified channel traffic; admin-gate negative
    admin.test.ts                  command schema, risk tiers, preview synthesis
    health.test.ts                 health assembler (home + reachable/unreachable remote)
    config.test.ts  clock.test.ts  drift.test.ts
    helpers/sim-server.ts          builds a sim-backed server + linked in-memory MCP Client
  examples/
    demo.ts               the headline demo (see M8) — sim-backed, no hardware
  docs/
    guide.md  api.md(generated)
    plans/2026-05-26-initial-prd.md  2026-05-27-execution-plan.md
```

---

## 4. Milestones

Each milestone is independently green (`bun run typecheck && bun run test`).
Order is dependency-driven. The full-stack seam (§1) exists from **M2** on, so
every tool/resource is proven through a real MCP client over a sim from the
moment it lands.

### M0 — Scaffold & toolchain parity
- Author `package.json` (incl. `bin`), the four `tsconfig`/`vitest`/`typedoc`
  configs, `.gitignore`, `LICENSE`, doc stubs, both CI workflows; rename
  `moat.yaml`'s `name` to `meshcore-mcp`.
- `bun install`: runtime `@modelcontextprotocol/sdk`, `@dpup/meshcore-ts`, `zod`;
  dev `@dpup/meshcore-sim`, `@liamcottle/meshcore.js`, `typescript`, `vitest`,
  `@types/node`, `typedoc`, `typedoc-plugin-markdown`.
- A trivial `createServer()` returning an `McpServer` with zero tools, plus
  `cli.ts` that starts it over stdio.
- **Done when:** `bun run typecheck`, `bun run test` (zero tests), `bun run build`
  all pass; a throwaway consumer compiles against `dist/` with no `TS7016`; and
  the built `cli.js` answers an MCP `initialize` over stdio.

### M1 — `MeshService` core + Clock + traffic buffer (the device-facing core)
- `clock.ts`: a `Clock` interface (`now()`, `setTimeout`, `clearTimeout`,
  `setInterval`, `clearInterval` — the exact shape meshcore-sim's `SimClock`
  satisfies structurally) and `SystemClock` (the production impl). PRD §6 rule:
  no raw `Date.now()`/`setTimeout` anywhere below the entrypoint.
- `service/mesh-service.ts`: `MeshService` constructed with an **injected**
  `MeshCoreClient` + `Clock`. On `start()` it `connect()`s, subscribes to the
  client's events, and feeds the traffic buffer. Exposes intent-shaped methods
  the tools call (`nodeHealth`, `surveyMesh`, `recentTraffic`, `sendMessage`,
  `runAdmin`) — *not* a 1:1 passthrough of the client.
- `service/traffic-buffer.ts`: a bounded ring buffer of recent live events, each
  stamped via the injected clock and tagged with provenance (the §1 table).
  Backs both `get_recent_traffic` and the live resource.
- **Done when:** an integration test builds a `MeshService` over a sim-backed
  `MeshCoreClient`, advances `SimClock`, and reads buffered traffic back — no MCP
  layer yet. The seam from §1 (minus MCP) is proven.

### M2 — Read tools (PRD §5.1) through the full MCP stack
- `tools/get-node-health.ts` — `get_node_health(node?)`. Home node: assemble
  `getSelfInfo` + `getBatteryVoltage` + `getStats*` + `getDeviceTime` into one
  snapshot. Remote node: collapse `login` → `getStatus`/`getTelemetry`. Hides the
  home-vs-remote distinction and the remote login (PRD §4). `readOnlyHint`,
  `idempotentHint`.
- `tools/survey-mesh.ts` — `survey_mesh()`: one consolidated roster of known
  nodes + contacts with last-heard times. `readOnlyHint`, `idempotentHint`.
- `tools/get-recent-traffic.ts` — `get_recent_traffic(since)`: drain the traffic
  buffer filtered by the injected clock. `readOnlyHint`, `idempotentHint`.
- `format.ts`: shape each result into a **structured, digested** output (Zod
  `outputSchema`), not raw frames (PRD §4 "minimal and high-signal").
- `errors.ts`: turn `MeshCoreError`/timeouts into actionable tool errors
  (*"rocky-ridge unreachable: no response after 3 attempts, last heard 2h ago"*,
  PRD §5.3) — `isError: true` results, not thrown exceptions.
- `test/helpers/sim-server.ts`: the reusable harness — build a world+scenario,
  a sim-backed `MeshService`, a `createServer`, and a linked in-memory MCP
  `Client`.
- **Done when:** through a real MCP `Client`, `get_node_health` (home + a
  reachable remote), `survey_mesh`, and `get_recent_traffic` return the world's
  data as structured output; an **unreachable** remote node yields a high-signal
  tool error, not a crash. Covers most of the PRD read surface.

### M3 — Action tools: `send_message` + `admin` (PRD §5.1, §5.3)
- `tools/send-message.ts` — `send_message(target, text)`: resolve a contact or
  channel, `sendTextMessage`/`sendChannelTextMessage`. Annotations: **not**
  read-only, **not** idempotent (a resend is a second transmission — PRD §5.3).
- `service/admin.ts` — the **enumerated, curated** admin command set (PRD §5.1),
  defined in full in **§9**. Each command declares a Zod param schema, a **risk
  tier** (→ `readOnlyHint`/`destructiveHint`/`idempotentHint`), a `scope`
  (home+remote vs remote-only), a structured `home()` path and/or a `remoteCli()`
  string, and a **`preview()`** that synthesizes the dry-run text *without
  contacting the device* (PRD §5.3). Dispatch: home node → structured
  `MeshCoreClient` method; remote node → `login` → `sendTextMessage(node, cli,
  TxtType.CliData)` → reply as a `CliData` `contactMessage`, correlated by
  sender + timing (no explicit logout — §6).
- `tools/admin.ts` — `admin(node, command, params?, dryRun?)`: dispatches into the
  set; `dryRun` returns the synthesized preview; otherwise collapses the remote
  handshake. `destructiveHint` varies by command; never idempotent.
- **Done when:** sim-backed tests show `send_message` enqueues a transmission the
  sim observes; `admin(node, "reboot", { dryRun: true })` returns an intent
  preview having touched nothing; a real remote `admin` exec drives the
  `login` → `CliData` → reply handshake and the sim's **scripted reply** (matched
  by sender + timing) comes back as a structured result; annotations match the
  risk tiers.

### M4 — Resources + the live stream with provenance (PRD §5.2)
- `resources/traffic-live.ts` — `meshcore://traffic/live`, **subscribable**. On
  each buffered live event the server sends `notifications/resources/updated`;
  reads return recent events. Every event carries the §1 provenance fields.
- `resources/nodes.ts` (`meshcore://nodes`) and `resources/contacts.ts`
  (`meshcore://contacts`) — pull-style roster/contacts (PRD §5.2).
- **Done when:** an MCP `Client` subscribes to `meshcore://traffic/live`, the test
  advances `SimClock` through a `traffic.burst`, and the client receives update
  notifications in order; a **decrypt-verified channel message** and an
  **unverified admin-channel datagram** are both delivered, and the stream marks
  them differently (`decryptVerified` true vs false) — the negative case never
  appears as a verified channel message. This is the milestone the provenance
  requirement exists for.

### M5 — Prompt templates (PRD §5.4)
- `prompts/index.ts` — a small curated set, parameterized, that *frames* without
  freezing (PRD §5.4): e.g. `morning-mesh-check`, `diagnose-quiet-node(node)`,
  `draft-outage-notice(node, window)`. Each points at existing tools; none
  re-implements device logic; no policy, no secrets.
- **Done when:** an MCP `Client` lists the prompts and renders one with arguments
  into a coherent starting message that references the real tool names.

### M6 — Server entrypoint, config & connection lifecycle (PRD §6)
- `config.ts` — read the home node address (`MESHCORE_HOST`/`MESHCORE_PORT` for
  `companion_radio_wifi`, or a serial path), transport selection, and — for
  remote admin — node admin credentials and channel keys, from env/flags.
  Validate with Zod; fail fast with a legible message.
- `cli.ts` — build the real `MeshCoreClient` from config + a `SystemClock`,
  construct `MeshService`, `createServer`, connect a `StdioServerTransport`, and
  handle graceful shutdown (close the client + transport on SIGINT/SIGTERM).
- **Done when:** `MESHCORE_HOST=… meshcore-mcp` starts, completes an MCP
  handshake over stdio, and a malformed/missing config exits non-zero with a
  clear error. (Stdio is v1; streamable-HTTP is out of scope — §8.)

### M7 — Drift guard (keep the contracts honest)
- `test/drift.test.ts` — mirror image of meshcore-ts/sim's drift tests: assert the
  `MeshCoreClient` methods and event names `MeshService` depends on still exist on
  the installed `@dpup/meshcore-ts`, and that the MCP SDK entry points we import
  resolve. A dependency bump that moves either contract fails here, loudly.
- **Done when:** the test passes on current deps and names exactly what to
  reconcile if a future bump breaks a contract.

### M8 — Demo script (headline deliverable)
`examples/demo.ts` — a self-contained, runnable narrative (no hardware) that
proves the server does what the PRD promises, in the voice of meshcore-sim's
`demo.ts` and meshcore-ts's `monitor.ts` (TTY-aware color, deterministic output).
It drives an **in-memory MCP `Client`** against a **sim-backed** server:
1. Build a small world with `defineWorld` (home node, two contacts, a public and
   a private/admin channel, one offline repeater) + a `SimClock`.
2. Wire `MeshCoreClient(sim.asConnection())` → `MeshService` → `createServer` →
   linked `Client`.
3. **Tools:** call `get_node_health` (home + the offline repeater failing
   cleanly), `survey_mesh`, then `send_message`.
4. **Live + provenance:** subscribe to `meshcore://traffic/live`, attach a
   `traffic.burst`, `advance` the clock, and watch events arrive in compressed
   virtual time — showing a verified channel message vs. an unverified
   admin-channel datagram side by side.
5. **Admin:** show `admin(node, "reboot", { dryRun: true })` previewing intent,
   then a real scripted exec.
6. **Determinism:** re-run with the same `--seed`, identical output.
- **Done when:** `bun examples/demo.ts [--seed <n>]` runs deterministically end to
  end and reads as a tour of the whole feature set.

### M9 — Docs, CI, release
- `README.md`: badges, one-paragraph pitch ("a MeshCore node — and the mesh
  behind it — as a clean MCP surface for any agent"), the **Claude Code MCP
  config** snippet (the primary consumer, PRD §2/§6), the tool/resource/prompt
  table, install, the sim-backed quickstart, design notes.
- `docs/guide.md`: concepts & recipes — configuring the home node, the tool
  surface and annotations, the live stream & provenance, the `admin` set &
  dry-run, the three consumers (PRD §2), testing your own agent against a
  sim-backed server.
- `docs/api.md`: generated via `bun run docs`; committed and CI-gated.
- `llms.txt`, `AGENTS.md`, `CLAUDE.md`: in the shared voice, with a don't-regress
  list (the two contracts; provenance table; injected clock; annotations as the
  boundary; `admin` is enumerated, never free-form).
- CI green; release workflow staged (Trusted Publishing configured on npmjs.com
  for `@dpup/meshcore-mcp`, repo `dpup/meshcore-mcp`).
- **Done when:** `bun run docs:check` passes; README quickstart compiles;
  `npm version patch && git push --follow-tags` would publish.

---

## 5. Testing strategy

- **The centre of gravity is the full-stack seam (§1):** a real MCP `Client` over
  an in-memory transport → `createServer` → `MeshService` → a real
  `MeshCoreClient` → `SimConnection`. Assert on **tool/resource/prompt results**
  (structured output, annotations, error results, notifications) — never on
  server internals. This proves both contracts at once and is what
  `test/helpers/sim-server.ts` exists to make cheap.
- **Provenance / adversarial:** the admin-gate negative cases and
  decrypt-verification outcomes get dedicated tests — inputs you cannot safely
  make on hardware (PRD §2), authored via meshcore-sim's scenario provenance.
- **Time-domain:** `get_recent_traffic(since)` and live ordering are tested by
  advancing `SimClock`, never by sleeping — the PRD §6 injected-clock rule is
  what makes this possible and is itself asserted (no `Date.now()` below the
  entrypoint).
- **Unit** where it pays: `config` parsing/validation, `admin` schemas + risk
  tiers + preview synthesis, the health assembler, the traffic buffer, the clock.
- **Drift** (M7) guards the contract surfaces against dependency bumps.
- **No hardware.** A live smoke against a real node is a manual, documented step,
  not part of CI.

---

## 6. PRD open questions — decisions carried into the build

- **§8.1 enumerated `admin` set — pinned down in §9.** A curated 16-command
  subset of MeshCore's repeater CLI, each with params, scope (home+remote vs
  remote-only), a risk tier → annotation mapping, and a synthesized dry-run
  preview. Extensible; never free-form text.
- **§8.2 remote-admin transport — confirmed (no longer a risk).** Verified
  against three reference implementations: meshcore.js wire frames, `meshcore_py`'s
  `send_cmd`, and `meshcore-cli`'s command flow. A remote CLI/admin command is
  just a **text message with `txtType = CliData (1)`** — `meshcore_py`'s `send_cmd`
  emits the byte-identical frame to `send_msg` save that one type byte, and
  meshcore.js's `sendTextMessage(dst, text, type)` passes the type straight
  through. So through meshcore-ts: `login(node, password)` →
  `sendTextMessage(node, cmd, TxtType.CliData)`; the repeater's reply returns as
  an ordinary `contactMessage` (drained via `MsgWaiting`) whose `txtType` is
  `CliData`. Two nuances the build must handle — **not** open questions:
  1. **No explicit logout in meshcore.js 1.13.0.** `meshcore_py` has a logout
     command (`0x1d`); the JS lib (and thus meshcore-ts) exposes none. Repeater
     login sessions expire server-side, so "teardown" is implicit/best-effort —
     the handshake `admin` collapses is really **login → command(s) → (session
     expiry)**, not an explicit logout. (If upstream adds logout, the M7 drift
     test surfaces the new method.)
  2. **No request/response correlation on the wire.** CLI replies are plain
     contact messages with no request id; correlate by **sender `pubKeyPrefix` +
     timing within a timeout** (exactly as meshcore-cli does: send, then await the
     next message(s) from that node). Long output may span multiple messages.
  Home-node admin stays unambiguous (direct `MeshCoreClient` methods) and is built
  first; the remote path is exercised by meshcore-sim's **scripted-reply**
  capability in M3.
- **Transport:** stdio for v1 (PRD §6); streamable-HTTP deferred (§8).
- **Clock:** an injected `Clock` (PRD §6 design rule); `SystemClock` in prod,
  `SimClock` in tests. Owned by `meshcore-mcp`, satisfied structurally by the sim.
- **Packaging:** standalone repo `@dpup/meshcore-mcp`, an executable server with a
  `bin` (§2). *Settled.*

---

## 7. Sequencing & checkpoints

```
M0 ─▶ M1 ─▶ M2 (read tools, full stack) ─▶ M3 (actions+admin) ─▶ M4 (resources+provenance)
                                                                      │
                                          M5 (prompts) ──────────────┤
                                          M6 (entrypoint/config) ─────┼─▶ M7 (drift) ─▶ M8 (demo) ─▶ M9 (docs/CI/release)
```

Natural PR boundaries: **(A)** M0–M2 — scaffold + `MeshService` + read tools
proven through the full MCP→sim stack; **(B)** M3–M4 — actions, admin, and the
live-stream provenance (the core value + the main risk); **(C)** M5–M6 — prompts
+ entrypoint/config; **(D)** M7–M9 — drift, demo, docs, release.

Suggested first PR: **(A)**, ending with a passing test that calls
`get_node_health` through a real MCP client against a sim-backed world. That one
test de-risks **both** contracts before any action/admin work.

---

## 7a. Execution orchestration & human-involvement map

Executed **autonomously, subagent-driven, hands-off to the end**, mirroring
meshcore-sim's run. Commits land per milestone (branch off `main`; PRs per the §7
boundaries once a GitHub remote exists).

**Loop, per milestone Mn:**
1. Orchestrator spawns one implementation subagent with the milestone spec +
   conventions + done-when, instructed to run `typecheck`/`test`/`build` and
   report. (M0 scaffold done by the orchestrator directly — precision-critical
   template-mirroring of meshcore-sim's configs.)
2. Orchestrator **independently re-runs the validation gates** — self-reports are
   never trusted.
3. Green → commit. Red → fix directly or via a targeted fix subagent, **bounded
   to 2 attempts**, then escalate.

**Validation gates (the human's proxy):** `bun run typecheck`, `bun run test`,
`bun run build`, the `TS7016` throwaway-consumer probe, the stdio `initialize`
smoke, `bun run docs:check`, plus each milestone's machine-checkable done-when.
The spine is **full-stack tests: a real MCP `Client` → server → sim-backed
`MeshCoreClient`** (§5).

**Human involvement — only these:**
- *Setup* (done): the PRD decisions and this plan.
- *Mid-run escalation* (rare, by design): a gate that fails twice, or an
  unforeseen **public-surface** fork. The remote-admin transport is now confirmed
  (§6), so the residual unknown is narrow: a remote node on older/newer firmware
  whose CLI reply *text* differs from the documented shape (M3 parses free-text
  replies) — surfaces in M3, not as a structural blocker.
- *Final*: review the result; then the two human-only steps — configure npm
  **Trusted Publishing** on npmjs.com for `@dpup/meshcore-mcp`, and authorize the
  release tag/publish (M9 stages the workflow; it does not publish). The first
  release should also confirm the Claude Code MCP-config snippet against a real
  node (the one manual hardware smoke).

---

## 8. Out of scope (v1) — from PRD §7, §8

- **No policy layer.** No conversation policy, admin-channel gate, coalescing,
  scheduling, or autonomous behavior — that is `meshcore-elmer`, and only
  autonomous consumers need it (PRD §7). The server stays ungated by design.
- **Transport:** streamable-HTTP / any remotely-exposed deployment. v1 is
  local-process stdio only (PRD §6).
- **Auth/multi-tenant:** none — the server trusts its local launcher (PRD §2/§6).
- **Capture-and-replay fixtures** from real hardware (a meshcore-sim feature not
  built in its v1) — note as a future testing upgrade, not a dependency.

---

## 9. The enumerated `admin` command set (resolves PRD §8.1)

A **curated subset** of MeshCore's repeater/room-server CLI
([`docs/cli_commands.md`](https://github.com/meshcore-dev/MeshCore/blob/main/docs/cli_commands.md)),
not the whole ~70-command surface — "a handful per category beats dozens"
(PRD §4). Each entry is a typed, enumerated command; `admin`'s `command` argument
is validated against these names and is **never** free-form text.

**Dispatch.** The home node is reached over the companion protocol, so home-node
admin uses **structured `MeshCoreClient` methods**. A remote node is reached by
`login` → `sendTextMessage(node, cli, TxtType.CliData)`, reply correlated by
sender + timing (§6). Commands with no companion-protocol equivalent are
therefore **remote-only**.

**Firmware safety gate (verified, leaned on).** The repeater firmware's
`handleCommand(sender_timestamp, …)` treats `sender_timestamp == 0` as "from the
local serial console" and **refuses serial-only commands when sent remotely**:
`erase`/factory-reset, `set freq`, `get prv.key`, `stats-*`, and `log` (print).
meshcore-mcp's CliData frames always carry a timestamp, so those are
firmware-rejected over the mesh regardless — we simply don't expose them in the
remote set. (Remote stats use the structured `getStatus`; config reads use
read-only `get …`, surfaced via `get_node_health`, not `admin`.)

### Risk tier → MCP annotations (deterministic, for meshcore-elmer's §8.5 tiers)

| tier | `readOnlyHint` | `destructiveHint` | `idempotentHint` | meaning |
|---|---|---|---|---|
| `read` | true | false | true | a query (mostly handled by `get_node_health`, not here) |
| `benign` | false | false | false | transmits / toggles ephemeral state; safe, but an action |
| `config` | false | false | true | durable, reversible setting change |
| `sensitive` | false | **true** | true | reversible but security-/lockout-relevant; gate like destructive |
| `destructive` | false | **true** | false | reboot / data-loss / takes the node offline |

### The set (v1 — 16 commands)

| `command` | params | scope | maps to (home → / remote CLI) | tier |
|---|---|---|---|---|
| `reboot` | — | home+remote | `reboot()` / `reboot` | destructive |
| `advert` | `mode?: "flood"\|"zerohop"` (def. flood) | home+remote | `sendFloodAdvert()`/`sendZeroHopAdvert()` / `advert`·`advert.zerohop` | benign |
| `sync-time` | — | home+remote | `syncDeviceTime()` / `clock sync` | benign |
| `set-tx-power` | `dbm: 1–22` | home+remote | `setTxPower(dbm)` / `set tx <dbm>` | config |
| `set-radio` | `freqMhz, bwKhz, sf: 5–12, cr: 5–8` | home+remote | `setRadioParams(…)` / `set radio <f>,<bw>,<sf>,<cr>` | config |
| `set-name` | `name: ≤32 bytes` | home+remote | `setAdvertName(name)` / `set name <name>` | config |
| `set-location` | `lat, lon` | home+remote | `setAdvertLatLong(lat,lon)` / `set lat <lat>` + `set lon <lon>` | config |
| `set-admin-password` | `password: ≤15` | remote-only | — / `password <pw>` | sensitive |
| `set-repeat` | `enabled: bool` | remote-only | — / `set repeat on\|off` | config |
| `set-dutycycle` | `percent: 1–100` | remote-only | — / `set dutycycle <n>` | config |
| `log-start` | — | remote-only | — / `log start` | benign |
| `log-stop` | — | remote-only | — / `log stop` | benign |
| `log-erase` | — | remote-only | — / `log erase` | destructive |
| `clear-stats` | — | remote-only | — / `clear stats` | destructive |
| `remove-neighbor` | `pubKeyPrefix: hex` | remote-only | — / `neighbor.remove <prefix>` | destructive |
| `set-permission` | `pubKey: hex, level: guest\|read\|readwrite\|admin\|null` | remote-only | — / `setperm <pubkey> <0–3>` (omit ⇒ remove) | sensitive |

### Synthesized dry-run previews (intent, no device contact)

- **reboot** — "Reboot {node}. Unreachable for ~30–60s while it restarts; any session ends."
- **advert** — "{node} broadcasts a {mode} advert now. Costs airtime; floods propagate mesh-wide."
- **sync-time** — "Set {node}'s clock to the controller's time ({iso}). No-op if already in sync."
- **set-tx-power** — "Set {node} TX power to {dbm} dBm. ⚠ Confirm legal for your band/region; some boards add a PA stage on top."
- **set-radio** — "Set {node} radio to {freq} MHz / {bw} kHz / SF{sf} / CR{cr}. ⚠ Applies after a reboot; if it stops matching the mesh, {node} drops off the network."
- **set-name** — "Rename {node} to \"{name}\" (max 32 bytes, 24 if a location is set)."
- **set-location** — "Set {node}'s advertised location to {lat}, {lon}."
- **set-admin-password** — "Change {node}'s admin password. ⚠ Sent over the mesh as CliData and echoed in the reply; mis-setting can lock out admins. Secret — must not be retained in the traffic buffer."
- **set-repeat** — "Turn packet repeating {on|off} on {node}. ⚠ 'off' stops {node} relaying mesh traffic."
- **set-dutycycle** — "Set {node} duty-cycle limit to {percent}%. (firmware ≥ 1.15; older nodes use the airtime-factor knob.)"
- **log-start / log-stop** — "{Begin|Stop} capturing {node}'s RX log to storage."
- **log-erase** — "Erase {node}'s captured RX log. ⚠ The capture is lost."
- **clear-stats** — "Reset {node}'s packet/radio counters to zero. ⚠ Historical counts are lost."
- **remove-neighbor** — "Remove neighbour(s) matching prefix {prefix} from {node}'s list."
- **set-permission** — "Set {pubKey}'s permission on {node} to {level} (or remove). ⚠ 'admin' grants full control of {node}."

### Implementation shape

```ts
type RiskTier = "read" | "benign" | "config" | "sensitive" | "destructive";

interface AdminCommandDef<P = unknown> {
  name: string;                         // the enum value, e.g. "set-tx-power"
  tier: RiskTier;                       // -> annotations via annotationsForTier()
  scope: "home+remote" | "remote-only";
  params: z.ZodType<P>;                 // empty object schema when no params
  /** Synthesized dry-run text; MUST NOT contact the device. */
  preview(node: NodeRef, p: P): string;
  /** Home path: a structured MeshCoreClient call. Absent => remote-only. */
  home?(client: MeshCoreClient, node: NodeRef, p: P): Promise<unknown>;
  /** Remote path: the repeater CLI string(s) sent as CliData after login. */
  remoteCli(p: P): string | string[];
}

// One frozen registry; the `admin` tool validates `command` against its keys and
// derives MCP annotations from `tier`. Adding a command is one new entry.
const ADMIN_COMMANDS: Record<string, AdminCommandDef>;
```

### Deliberately deferred (the set is extensible — one row each when needed)

`start ota`, `clkreboot`, **`erase`/factory-reset** (serial-only + irreversible),
`set freq` (serial-only; use `set-radio`), `tempradio`, `radio.rxgain`,
`owner.info`, `adc.multiplier`, **`prv.key`** (serial-only), `set-guest-password`,
`path.hash.mode`, `loop.detect`, `txdelay`/`direct.txdelay`/`rxdelay`,
`int.thresh`, `agc.reset.interval`, `multi.acks`, the advert-interval and
`flood.max` knobs, `powersaving`, `allow.read.only`, `discover.neighbors`, and the
entire **region / GPS / sensor / bridge** subsystems (large, conditionally
compiled). Each is a one-row addition to the table above when an operator need
arises — never free-form text.
