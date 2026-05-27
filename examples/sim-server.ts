#!/usr/bin/env bun
/**
 * meshcore-mcp — a **sim-backed** server you can actually connect to.
 *
 * This serves the real MCP surface over **stdio**, but backed by
 * `@dpup/meshcore-sim` instead of a radio — so you can wire it into Claude Code
 * (or any MCP client) and try the tools, resources, and prompts with no
 * hardware. It is the {@link createServer} server from `src/`, wired to a
 * `SimConnection` over a small simulated mesh, with a real-time clock pump so
 * live traffic genuinely flows while you poke at it.
 *
 * The production entrypoint (`src/cli.ts`) only speaks to real devices (TCP /
 * serial); `@dpup/meshcore-sim` is a dev dependency and never ships. This file
 * lives in `examples/` for exactly that reason — it is the "try it" harness, not
 * the product.
 *
 * ## Run it directly
 *
 * ```sh
 * bun examples/sim-server.ts
 * ```
 *
 * It then waits on stdin for an MCP client. To use it from **Claude Code**:
 *
 * ```sh
 * claude mcp add meshcore-sim -- bun /ABSOLUTE/PATH/TO/examples/sim-server.ts
 * ```
 *
 * (or add the equivalent entry to your MCP config — see the README). Then ask
 * Claude to "survey the mesh", "check the health of Rocky Ridge", "show recent
 * traffic", or "preview an admin reboot of Rocky Ridge".
 *
 * ## What's simulated
 *
 * A four-node mesh — a home companion, two repeaters (one offline), a companion
 * contact — with a public and a private/admin channel, plus a live timeline:
 * messages, a verified channel message vs. an unverified admin-channel datagram
 * (the provenance distinction), adverts, and a node dropping offline then
 * recovering. A `--seed <n>` flag varies the seeded burst.
 *
 * Note: stdout is the MCP protocol channel — **all logging goes to stderr**.
 */
import { MeshCoreClient, TxtType } from "@dpup/meshcore-ts";
import {
  RealtimeClock,
  SimClock,
  SimConnection,
  at,
  channel,
  contact,
  defineWorld,
  node,
  scenario,
  traffic,
} from "@dpup/meshcore-sim";
import type { Responder, Scenario } from "@dpup/meshcore-sim";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "../src/server.js";
import { MeshService } from "../src/service/mesh-service.js";

/** stderr-only logging — stdout is reserved for the MCP protocol. */
function log(msg: string): void {
  process.stderr.write(`meshcore-mcp (sim): ${msg}\n`);
}

/** The admin/private channel index, used for the unverified-datagram demo. */
const ADMIN_CH = 7;

/** Parse an optional `--seed <n>` (or positional integer); defaults to 42. */
function parseSeed(argv: string[]): number {
  const i = argv.indexOf("--seed");
  if (i !== -1 && argv[i + 1] !== undefined) return Number(argv[i + 1]);
  const positional = argv.find((a) => /^\d+$/.test(a));
  return positional !== undefined ? Number(positional) : 42;
}

/** A small but lived-in mesh: home + two repeaters (one offline) + a companion. */
function buildWorld() {
  return defineWorld({
    homeNodeId: "home-base",
    nodes: [
      node("home-base", { name: "Home Base" }),
      node("rocky-ridge", { name: "Rocky Ridge", role: "repeater", battery: 64 }),
      node("cedar-creek", { name: "Cedar Creek" }),
      // Offline from the start — get_node_health on it fails cleanly.
      node("silent-peak", { name: "Silent Peak", role: "repeater", reachable: false }),
    ],
    channels: [channel(0, "public"), channel(ADMIN_CH, "admin", { kind: "private" })],
    contacts: [
      contact("Rocky Ridge", "rocky-ridge"),
      contact("Cedar Creek", "cedar-creek"),
      contact("Silent Peak", "silent-peak"),
    ],
  });
}

/**
 * A live timeline spread across ~2 minutes so the live stream and
 * `get_recent_traffic` have evolving content to show — a seeded burst, the
 * verified-vs-unverified provenance pair, adverts, and a node flapping offline.
 */
function buildScenario(seed: number): Scenario {
  const burst = traffic.burst({ from: "rocky-ridge", count: 3, within: "12s", seed });
  const rest = scenario([
    at("8s", { kind: "channelMessage", channel: 0, text: "net control: all stations green" }),
    // Claims the admin channel but isn't decrypt-verified — never surfaces as a
    // verified channel message (the admin-gate negative case).
    at("13s", { kind: "channelMessage", channel: ADMIN_CH, verified: false, snr: 7, text: "(encrypted)" }),
    at("20s", { kind: "advert", nodeId: "cedar-creek" }),
    at("30s", { kind: "message", from: "cedar-creek", text: "heading up the ridge, back by 1700" }),
    at("48s", { kind: "nodeState", nodeId: "rocky-ridge", reachable: false }),
    at("72s", { kind: "nodeState", nodeId: "rocky-ridge", reachable: true }),
    at("78s", { kind: "advert", nodeId: "rocky-ridge" }),
    at("95s", { kind: "message", from: "rocky-ridge", text: "back online, antenna reseated" }),
  ]);
  return scenario([...burst.events, ...rest.events]);
}

/** A plausible repeater CLI reply for a command, for the responder below. */
function cliReplyFor(cmd: string): string {
  if (cmd === "reboot") return "OK - rebooting in 3s";
  if (cmd === "advert" || cmd === "advert.zerohop") return "(advert sent)";
  if (cmd === "clock sync") return "clock synced";
  if (cmd.startsWith("set ")) return `OK - ${cmd}`;
  if (cmd.startsWith("get ")) return cmd.slice(4) + " = <value>";
  return "OK";
}

/**
 * Reactive replies (meshcore-sim ≥ 0.2.0): when the server logs into a repeater
 * and sends a CLI command as `CliData` text, the addressed node answers — so
 * remote `admin` actually round-trips here, instead of timing out. The reply
 * comes back from the same node (`msg.to`), correlated by sender exactly as the
 * real `login → CliData → reply` handshake is (PRD §6).
 */
function buildResponders(): Responder[] {
  return [
    {
      when: (msg) => msg.kind === "contact" && msg.txtType === TxtType.CliData,
      reply: (msg) =>
        msg.to === undefined
          ? undefined
          : { from: msg.to, text: cliReplyFor(msg.text), after: "1s" },
    },
  ];
}

async function main(): Promise<void> {
  const seed = parseSeed(process.argv.slice(2));
  const world = buildWorld();
  const scn = buildScenario(seed);

  // The sim-backed stack: SimConnection -> MeshCoreClient(autoSync) ->
  // MeshService -> createServer. One SimClock drives both the scenario timeline
  // and the service's event timestamps.
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock, scenario: scn, responders: buildResponders() });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  const service = new MeshService(client, clock);
  await service.start();

  const server = createServer({ service });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`serving over stdio — sim mesh "${world.homeNodeId}", seed ${seed}.`);
  log("connect an MCP client (e.g. `claude mcp add meshcore-sim -- bun <this file>`).");

  // Drive virtual time from the wall clock so the scenario fires and live
  // traffic flows while a client is connected (meshcore-sim ≥ 0.2.0's
  // RealtimeClock — the one place real timers are intended). Without it the
  // simulated clock never moves and the live stream stays silent.
  const realtime = new RealtimeClock(clock).start();

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down.`);
    realtime.stop();
    void (async () => {
      try {
        await service.stop();
        await server.close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log(`failed to start: ${String(err)}`);
  process.exitCode = 1;
});
