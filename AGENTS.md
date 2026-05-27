# AGENTS.md

Guidance for AI agents (and humans) working on **meshcore-mcp**. Keep this
current when architecture or conventions change.

## What this is

A Model Context Protocol (MCP) server that exposes a MeshCore node — and the
mesh reachable through it — as a clean, high-signal surface of **tools,
resources, and prompts** for any MCP client (Claude Code, or meshcore-elmer's
bridge). It is the *device layer*, and **ungated by design**: it contains no
conversation policy, admin-channel gate, or autonomous behavior (that belongs to
`meshcore-elmer`). See `docs/plans/` for the PRD (v0.3) and execution plan.

Companion projects, by the same author — keep all three consistent in stack,
style, and tone:

- [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts) — the typed device
  client this server is built on (runtime dependency).
- [`@dpup/meshcore-sim`](https://github.com/dpup/meshcore-sim) — the deterministic
  simulator we test and demo against (dev dependency; never shipped).

## The two contracts (read this first)

meshcore-mcp is a thin server wedged between two contracts it does **not** own.

**Below — `@dpup/meshcore-ts`.** The server holds one persistent `MeshCoreClient`
(`autoSync: true`) and consumes its *normalized* surface: named events
(`contactMessage`, `channelMessage`, `channelData`, `advert`, …), typed models,
hex-string keys, `Date` timestamps, typed errors. It never touches
`@liamcottle/meshcore.js` directly. `MeshService` takes its `MeshCoreClient` by
**injection** — production builds `MeshCoreClient.tcp(host, port)`; tests build
`new MeshCoreClient(sim.asConnection())`. Nothing below `MeshService` knows which.

**Above — MCP**, via `@modelcontextprotocol/sdk`'s `McpServer`: tools
(`registerTool`, Zod schemas, annotations), resources (`registerResource`, the
subscribable live stream), prompts (`registerPrompt`), over a
`StdioServerTransport`.

**The full-stack test seam** exercises both at once, in-process, no hardware:

```
MCP Client ⟷ InMemoryTransport ⟷ McpServer[meshcore-mcp]
                                    → MeshService → MeshCoreClient → SimConnection → world+SimClock
```

Assert on the **tool/resource/prompt result**, never on server internals. That
is the centre of gravity (`test/helpers/sim-server.ts`).

## Remote admin (provenance & the CliData path)

- A remote admin command is `client.login(node, pwd)` then
  `client.sendTextMessage(node, cmd, TxtType.CliData)`; the reply returns as an
  ordinary `contactMessage` (txtType `CliData`), correlated by sender + timing.
  There is **no explicit logout** in meshcore.js 1.13.0 (sessions expire), and
  **no request/response id** on the wire.
- Decrypt-verification is **structural**: `contactMessage` (direct),
  `channelMessage` (verified channel), `channelData`/`rawData` (unverified). The
  live stream preserves that distinction (PRD §5.2).
- `admin` exposes an **enumerated, curated** command set (execution plan §9) —
  never free-form text. Home node → structured `MeshCoreClient` methods; remote
  node → CLI text. Each command carries a risk tier → MCP annotations.

## Layout

```
src/
  index.ts        Library surface (re-exports createServer, + later MeshService/types).
  cli.ts          #! entrypoint: build client+service, serve over stdio (M6).
  server.ts       createServer(): wires tools + resources + prompts onto McpServer.
  version.ts      VERSION (kept in step with package.json).
  config.ts       env/flags -> validated Config (M6).
  clock.ts        Clock interface + SystemClock (M1).
  service/        MeshService (device-facing core), traffic buffer, health, admin (M1, M3).
  tools/          one registrar per tool: get_node_health, survey_mesh, … (M2–M3).
  resources/      traffic-live, nodes, contacts (M4).
  prompts/        curated prompt templates (M5).
test/             Vitest; full-stack tests drive a real MCP Client over a sim-backed server.
examples/demo.ts  The guided-tour demo (M8).
docs/api.md       GENERATED (TypeDoc) — do not hand-edit. docs/guide.md hand-written.
```

## Commands

```sh
bun install
bun run typecheck   # tsc --noEmit (strict, includes src/test/examples)
bun run test        # vitest run
bun run build       # tsc -p tsconfig.build.json -> dist/
bun run docs        # regenerate docs/api.md
bun run docs:check  # verify docs/api.md is in sync
bun run dev         # run the server over stdio (bun src/cli.ts)
```

**Use bun ≥ 1.2** (`engines.bun` + `moat.yaml` pin it): the committed lockfile is
the text `bun.lock`; bun 1.1.x writes the binary `bun.lockb` (gitignored).

## Conventions

- **ESM-only, Node-only.** `module`/`moduleResolution: NodeNext`; `.js` import
  extensions; `verbatimModuleSyntax` on — split type-only imports/exports.
- **strict + `noUncheckedIndexedAccess`.** Guard indexed reads.
- **Injected clock.** Take time from a `Clock` (`now()` + timer scheduling), never
  raw `Date.now()`/`setTimeout` below the entrypoint — `SystemClock` in prod,
  `SimClock` in tests.
- **Structured, digested output.** Every tool returns a typed `outputSchema`
  result; every error is actionable, not a raw frame (PRD §4, §5.3).
- **Annotations are the boundary.** Every tool declares
  `readOnlyHint`/`destructiveHint`/`idempotentHint` (PRD §5.3).

## Don't-regress list

1. **Injected `MeshCoreClient` + `Clock`** — `MeshService` never constructs its
   own; that seam is what the sim-backed tests depend on.
2. **No `Date.now()`/`setTimeout`** below the entrypoint — use the `Clock`.
3. **Provenance is structural** — don't collapse verified `channelMessage` vs.
   unverified `channelData`; the live stream must mark them differently.
4. **`admin` is enumerated**, never free-form; risk tier → annotations is
   deterministic.
5. **stdout is the MCP channel** — diagnostics go to stderr only.
6. **Assert app-visible behavior**, never sim/server internals.

## Testing

The centre of gravity is **integration tests driving a real MCP `Client` over a
sim-backed server** — the proof that both contracts hold. No hardware. The
provenance/admin negative cases are authored with meshcore-sim scenarios (inputs
you cannot safely make on hardware).

## Releasing

Tag-driven via `.github/workflows/release.yml` (npm Trusted Publishing / OIDC +
provenance). `npm version patch && git push --follow-tags`. Trusted publishing
must be configured for `@dpup/meshcore-mcp` on npmjs.com first.
