# meshcore-mcp

> A Model Context Protocol server that exposes a [MeshCore](https://meshcore.co.uk)
> node — and the mesh reachable through it — as a clean, high-signal interface
> for AI agents and tools.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Module: ESM](https://img.shields.io/badge/module-ESM-f7df1e.svg)](#)

`meshcore-mcp` wraps a [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts)
`MeshCoreClient` behind a small, deliberately shaped surface of MCP **tools,
resources, and prompts**. Point an MCP client at a node and operate the mesh in
natural language — survey nodes, read recent traffic, send messages, and run
curated admin commands — with structured results instead of raw frames.

It is the **device layer**, and ungated by design: no conversation policy, no
admin-channel gate, no autonomous behavior. A human at Claude Code is the policy;
an autonomous agent brings its own (that is `meshcore-elmer`'s job). Same server,
correct in both cases.

> **Status:** under active construction — see [`docs/plans/`](./docs/plans) for
> the PRD (v0.3) and the milestone execution plan. This README is expanded as the
> surface lands (M9).

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit (strict)
bun run test        # vitest — incl. full-stack tests over a sim-backed server
bun run build       # emit dist/ (ESM + .d.ts + the meshcore-mcp binary)
bun run dev         # run the server over stdio
```

See [AGENTS.md](./AGENTS.md) for architecture and contribution notes.

## License

[MIT](./LICENSE) © Dan Pupius
