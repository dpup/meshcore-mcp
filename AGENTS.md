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

Docs are three layers: `README.md` (landing + the Claude Code MCP-config snippet
+ the tool/resource/prompt tables), `docs/guide.md` (hand-written concepts &
recipes), and `docs/api.md` (**generated** by TypeDoc); `llms.txt` indexes all
three for agents.

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
  index.ts                Library surface — re-exports createServer, MeshService, the admin set,
                          traffic/health/error types, and every tool/resource/prompt registrar.
  cli.ts                  #! entrypoint: loadConfig → MeshCoreClient.tcp/.serial + SystemClock →
                          MeshService → createServer → StdioServerTransport, graceful shutdown.
  server.ts               createServer({ service }): wires tools + resources + prompts onto
                          McpServer. With no service it's the empty M0 smoke server.
  version.ts              VERSION (kept in step with package.json).
  config.ts               env/flags → validated Config; legible ConfigError, fail-fast.
  clock.ts                Clock interface + SystemClock + toMillis/Duration.
  errors.ts               toolError(): MeshCoreError/timeouts → actionable isError tool results.
  format.ts               model → structured, digested tool-output shaping (not raw frames).
  service/
    mesh-service.ts       MeshService — the device-facing core (injected client + clock + buffer).
    traffic-buffer.ts     Bounded ring buffer of recent live events, stamped + tagged with provenance.
    health.ts             The get_node_health / survey_mesh result assembler and types.
    admin.ts              ADMIN_COMMANDS — the frozen, enumerated 16-command set + annotationsForTier.
  tools/                  one registrar per tool: get-node-health, survey-mesh, get-recent-traffic,
                          send-message, admin.
  resources/              traffic-live (subscribable), nodes, contacts.
  prompts/index.ts        the three curated prompt templates.
test/                     Vitest; full-stack tests drive a real MCP Client over a sim-backed server
                          (helpers/sim-server.ts is the harness). drift.test.ts guards both contracts.
examples/demo.ts          The guided-tour demo — sim-backed, deterministic, no hardware.
docs/api.md               GENERATED (TypeDoc + scripts/postdocs.mjs) — do not hand-edit.
docs/guide.md             Hand-written concepts & recipes. llms.txt indexes all three doc layers.
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
3. **Provenance is structural** — don't collapse verified `channelMessage`/
   `contactMessage` vs. unverified `channelData`/`advert`/`raw`; the live stream
   and `get_recent_traffic` must carry a derived `decryptVerified` per event.
4. **`admin` is enumerated** (the frozen `ADMIN_COMMANDS`), never free-form; risk
   tier → annotations (`annotationsForTier`) is deterministic; `dryRun` previews
   are synthesized **without contacting the device**.
5. **Annotations are the boundary** — every tool declares
   `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`;
   `send_message` is non-idempotent; reads are read-only + idempotent.
6. **Structured, digested output + actionable errors** — every tool returns its
   typed `outputSchema`; failures are `isError` results via `toolError`, never a
   thrown exception or a raw frame.
7. **stdout is the MCP channel** — diagnostics go to stderr only.
8. **Radio units: surface is MHz/kHz; the device wire is kHz (freq) / Hz (bw)**
   (confirmed on hardware: 869.618 MHz → `radioFreq` 869618; 62.5 kHz →
   `radioBw` 62500). `set-radio`'s `home()` must scale **both** ×1000; the health
   read normalises **both** ÷1000 (`freqMhz`/`bwKhz`). The remote CLI takes
   MHz/kHz directly. Keep read and write in the same units.
9. **Fuzzy-input tolerance** (`src/coerce.ts`) — numeric/enum params accept the
   variants an LLM emits (kHz/Hz, `"22 dBm"`, `"SF7"`, `"4/5"`) and normalise,
   then range-check. The accepted forms live in each param's `.describe()` and
   surface in the `admin` tool description. Don't replace a coerced param with a
   bare `z.number()`.
8. **The drift test stays honest** — `test/drift.test.ts` names every
   `MeshCoreClient` method/event and MCP SDK entry point the server depends on; a
   dependency bump that moves either contract fails there, loudly. Reconcile, do
   not delete.
9. **Assert app-visible behavior**, never sim/server internals.
10. **`docs/api.md` is generated** — never hand-edit; run `bun run docs` and let
    `bun run docs:check` gate it in CI.

## Testing

The centre of gravity is **integration tests driving a real MCP `Client` over a
sim-backed server** — the proof that both contracts hold. No hardware. The
provenance/admin negative cases are authored with meshcore-sim scenarios (inputs
you cannot safely make on hardware).

## Releasing

Tag-driven via `.github/workflows/release.yml` (npm Trusted Publishing / OIDC +
provenance). `npm version patch && git push --follow-tags`. Trusted publishing
must be configured for `@dpup/meshcore-mcp` on npmjs.com first.
