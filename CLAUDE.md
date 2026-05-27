# CLAUDE.md

Project guidance for Claude Code lives in **[AGENTS.md](./AGENTS.md)** — read it
first. It covers the architecture, the two contracts, conventions, and the
don't-regress list.

## TL;DR

- An MCP server exposing a MeshCore node as tools/resources/prompts. Built on
  `@dpup/meshcore-ts`; tested/demoed against `@dpup/meshcore-sim`. Ungated by
  design — no policy layer (that's `meshcore-elmer`).
- `MeshService` takes an **injected** `MeshCoreClient` + `Clock`. Tests drive a
  real MCP `Client` (in-memory transport) → server → sim-backed client.
- Verify with: `bun run typecheck` · `bun run test` · `bun run build`.
- ESM-only, Node ≥ 18, `NodeNext`, `verbatimModuleSyntax`, `strict` — `.js`
  import extensions, split `import type` / `export type`.

## Don't-regress (details in AGENTS.md)

1. Injected `MeshCoreClient` + `Clock`; never construct them inside `MeshService`.
2. No `Date.now()`/`setTimeout` below the entrypoint — use the `Clock`.
3. Provenance is structural: verified `channelMessage` vs. unverified `channelData`.
4. `admin` is an enumerated, curated set (execution plan §9) — never free-form.
5. stdout is the MCP channel; diagnostics to stderr.

## Planning docs

- `docs/plans/2026-05-26-initial-prd.md` — the PRD (Spec v0.3).
- `docs/plans/2026-05-27-execution-plan.md` — milestones M0–M9, the two
  contracts, and §9 the enumerated `admin` set.
