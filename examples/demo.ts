/**
 * meshcore-mcp — a guided tour you can run.
 *
 * No hardware, no external app, no real MCP host: this drives an **in-memory
 * MCP `Client`** against the real meshcore-mcp server, which in turn runs a real
 * `@dpup/meshcore-ts` `MeshCoreClient` over a `@dpup/meshcore-sim`
 * `SimConnection`. Everything the tour prints below the wiring step is exactly
 * what a real MCP host — Claude Code, say — would see calling this server.
 *
 * The whole stack runs in one process, no sockets:
 *
 *   MCP Client ⟷ InMemoryTransport ⟷ McpServer(meshcore-mcp)
 *                 → MeshService → MeshCoreClient → SimConnection → world+SimClock
 *
 * It walks through, in order:
 *   1. Build a world          (defineWorld + builders; one offline repeater)
 *   2. Wire the stack         (SimConnection → MeshCoreClient → server → Client)
 *   3. Tools                  (get_node_health home + offline, survey, send)
 *   4. Live + provenance      (subscribe, burst, verified vs. unverified)
 *   5. Admin                  (reboot dry-run preview, then a scripted exec)
 *   6. Determinism            (same --seed ⇒ byte-identical stdout)
 *
 * Usage:
 *   bun examples/demo.ts [--seed <n>]
 *   bun examples/demo.ts 1234        # positional seed
 *
 * The output is fully deterministic — it prints the *virtual* clock time, never
 * wall-clock time, and avoids unordered-collection iteration — so two runs with
 * the same seed produce byte-identical stdout.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import {
  SimClock,
  SimConnection,
  at,
  channel,
  contact,
  defineWorld,
  node,
  scenario,
  toMillis,
  traffic,
} from "@dpup/meshcore-sim";
import type { Scenario } from "@dpup/meshcore-sim";

// in your project: import { createServer, MeshService } from "@dpup/meshcore-mcp"
import {
  InMemoryCredentialStore,
  MeshService,
  createServer,
  TRAFFIC_LIVE_URI,
} from "../src/index.js";
import type { MeshSurvey, NodeHealth, TrafficEvent } from "../src/index.js";

// ---------------------------------------------------------------------------
// tiny ANSI helpers (no-op when not a TTY) — the monitor.ts / demo.ts style
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY === true;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const C = {
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  gray: "90",
} as const;

let section = 0;
/** Print a numbered section header. */
function header(title: string): void {
  section++;
  console.log("");
  console.log(bold(`${section}. ${title}`));
  console.log(dim("─".repeat(60)));
}

/** An indented detail line. */
function line(s = ""): void {
  console.log(`   ${s}`);
}

/** Format virtual time (ms since connect) as a fixed `t+SS.mmm` stamp. */
function vt(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const millis = ms % 1000;
  return dim(`t+${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}s`);
}

const short = (hex: string, n = 12) => hex.slice(0, n) + (hex.length > n ? "…" : "");

// ---------------------------------------------------------------------------
// seed (optional CLI arg) — output stays deterministic per seed
// ---------------------------------------------------------------------------
function parseSeed(argv: string[]): number {
  const flagIdx = argv.indexOf("--seed");
  if (flagIdx !== -1 && argv[flagIdx + 1] !== undefined) {
    return Number(argv[flagIdx + 1]);
  }
  const positional = argv.find((a) => /^\d+$/.test(a));
  return positional !== undefined ? Number(positional) : 42;
}

const SEED = parseSeed(process.argv.slice(2));

// ---------------------------------------------------------------------------
// the wired full stack — the test/helpers/sim-server.ts harness, inline so the
// demo is self-contained (it must NOT import from test/).
// ---------------------------------------------------------------------------

/** The wired stack: a real MCP `Client`, the server, the shared clock + sim. */
interface Harness {
  client: Client;
  clock: SimClock;
  advance(by: string | number): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Flush the microtask queue enough times for the client's `MsgWaiting →
 * getWaitingMessages() → emit` drain chain to fully settle. That chain is async
 * and re-entrant, spanning many microtask turns; a generous bounded loop drains
 * it deterministically without touching real time (it affects nothing the demo
 * prints, so output stays byte-identical run to run).
 */
async function flushMicrotasks(times = 64): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Build the full sim-backed MCP stack and link a real `Client` to it — the
 * §1 seam, in one process: `SimConnection → MeshCoreClient(autoSync) →
 * MeshService → createServer → InMemoryTransport → Client`.
 */
async function wireStack(world: ReturnType<typeof defineWorld>, scn?: Scenario): Promise<Harness> {
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock, scenario: scn });
  const meshClient = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  const service = new MeshService(meshClient, clock, {
    credentialStore: new InMemoryCredentialStore(),
  });
  await service.start();

  const server = createServer({ service });
  const client = new Client({ name: "meshcore-mcp-demo", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  /**
   * Advance the virtual clock by `by`, stepping in 250ms slices with a bounded
   * microtask flush between each so `autoSync` delivers each event near its own
   * fire time and traffic settles before we read it back (the harness pattern —
   * advancing in one big jump would collapse every event onto the far instant).
   */
  async function advance(by: string | number): Promise<void> {
    const totalMs = toMillis(by);
    const step = 250;
    let elapsed = 0;
    while (elapsed < totalMs) {
      const slice = Math.min(step, totalMs - elapsed);
      clock.advance(slice);
      elapsed += slice;
      await flushMicrotasks();
    }
    await flushMicrotasks();
  }

  async function cleanup(): Promise<void> {
    await client.close();
    await server.close();
    await service.stop();
  }

  return { client, clock, advance, cleanup };
}

/** A CallTool result, loosened for ergonomic reads. */
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

/** Pull the structured payload off a (successful) CallTool result. */
function structured<T>(res: unknown): T {
  return (res as ToolResult).structuredContent as T;
}

/** The single JSON contents payload of a resource read. */
function readJson<T>(res: unknown): T {
  const contents = (res as { contents?: Array<{ text?: string }> }).contents ?? [];
  return JSON.parse(contents[0]?.text ?? "{}") as T;
}

// ---------------------------------------------------------------------------
// the tour
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(bold("meshcore-mcp — guided tour"));
  console.log(
    dim(`a real MCP Client driving the server over a simulated mesh (seed ${SEED})`),
  );

  // -------------------------------------------------------------------------
  // 1. Build a world.
  // -------------------------------------------------------------------------
  header("Build a world");
  // A small mesh authored with strong-defaulted builders: a home node, two
  // contacts, a public channel and a private/admin channel, and one OFFLINE
  // repeater (reachable:false models a node we cannot query — the clean-failure
  // case). The SimClock is the virtual clock the whole stack shares.
  const ADMIN_CH = 7;
  const world = defineWorld({
    homeNodeId: "home-base",
    nodes: [
      node("home-base", { name: "Home Base" }),
      node("rocky-ridge", { name: "Rocky Ridge", role: "repeater", battery: 64 }),
      node("cedar-creek", { name: "Cedar Creek" }),
      // An offline repeater — reachable:false models a node we cannot reach.
      node("silent-peak", { name: "Silent Peak", role: "repeater", reachable: false }),
    ],
    channels: [channel(0, "public"), channel(ADMIN_CH, "admin", { kind: "private" })],
    contacts: [
      contact("Rocky Ridge", "rocky-ridge"),
      contact("Cedar Creek", "cedar-creek"),
      contact("Silent Peak", "silent-peak"),
    ],
  });

  const reachable = world.nodes.filter((n) => n.reachable).length;
  const offline = world.nodes.length - reachable;
  line(
    `${bold(String(world.nodes.length))} nodes ` +
      dim(`(${reachable} reachable, ${offline} offline)`) +
      `, ${bold(String(world.channels.length))} channels, ` +
      `${bold(String(world.contacts.length))} contacts`,
  );
  for (const n of world.nodes) {
    const tag = n.id === world.homeNodeId ? paint(C.cyan, "home") : n.role;
    const status = n.reachable ? paint(C.green, "online") : paint(C.red, "offline");
    line(`  ${paint(C.blue, "•")} ${bold(n.name.padEnd(12))} ${dim(tag.padEnd(10))} ${status}`);
  }
  for (const ch of world.channels) {
    line(`  ${paint(C.magenta, "#")} ch${ch.idx} ${bold(ch.name.padEnd(8))} ${dim(ch.kind)}`);
  }

  // -------------------------------------------------------------------------
  // 2. Wire the stack.
  // -------------------------------------------------------------------------
  header("Wire the stack");
  // SimConnection is the raw Connection drop-in; MeshCoreClient is the real,
  // unmodified typed wrapper; MeshService is the device-facing core; createServer
  // wires the MCP tools/resources/prompts; an in-memory transport links a real
  // MCP Client. Nothing below MeshService knows it is talking to a sim.
  const h = await wireStack(world);
  line(dim("MCP Client ⟷ InMemoryTransport ⟷ meshcore-mcp server"));
  line(dim("              → MeshService → MeshCoreClient → SimConnection → world"));

  const { tools } = await h.client.listTools();
  const { resources } = await h.client.listResources();
  line(
    `server exposes ${bold(String(tools.length))} tools ` +
      dim(`(${[...tools].map((t) => t.name).sort().join(", ")})`),
  );
  line(
    `and ${bold(String(resources.length))} resources ` +
      dim(`(${[...resources].map((r) => r.uri).sort().join(", ")})`),
  );
  line(dim("everything below is exactly what a real MCP host (Claude Code) would see."));

  // -------------------------------------------------------------------------
  // 3. Tools.
  // -------------------------------------------------------------------------
  header("Tools: health, survey, send");

  // get_node_health for the home node — one consolidated snapshot that hides
  // the underlying getSelfInfo/getBattery/getStats/getDeviceTime fan-out.
  const home = structured<NodeHealth>(
    await h.client.callTool({ name: "get_node_health", arguments: {} }),
  );
  line(
    `${paint(C.green, "✓")} get_node_health ${bold(home.node)} ${dim("(home)")}: ` +
      `${home.battery ? `battery=${(home.battery.milliVolts / 1000).toFixed(2)}V ` : ""}` +
      `${home.radio ? `radio=${home.radio.freqMhz.toFixed(3)}MHz/SF${home.radio.sf} ` : ""}` +
      dim(short(home.publicKey ?? "")),
  );

  // get_node_health for the OFFLINE repeater — it fails the way a real device
  // would, surfaced as a clean isError result (not a crash, no stack trace).
  const offlineRes = (await h.client.callTool({
    name: "get_node_health",
    arguments: { node: "Silent Peak" },
  })) as ToolResult;
  const offlineMsg = offlineRes.content?.[0]?.text ?? "";
  line(
    `${paint(C.red, "✗")} get_node_health ${bold("Silent Peak")} ${dim("(offline)")}: ` +
      `${offlineRes.isError ? paint(C.yellow, "isError") : "ok"} ${dim(`— ${offlineMsg}`)}`,
  );

  // survey_mesh — one roster of the home node + contacts, sorted for determinism.
  const survey = structured<MeshSurvey>(
    await h.client.callTool({ name: "survey_mesh", arguments: {} }),
  );
  const roster = [...survey.contacts].sort((a, b) => a.name.localeCompare(b.name));
  line(`${paint(C.green, "✓")} survey_mesh: home ${bold(survey.home.name)} + ${roster.length} contacts:`);
  for (const c of roster) {
    line(`    ${paint(C.blue, "•")} ${bold(c.name.padEnd(12))} ${dim(short(c.publicKey))}`);
  }

  // send_message to a contact — the sim resolves the contact and acks the send.
  const sent = structured<{ contact?: string; text: string; publicKey?: string }>(
    await h.client.callTool({
      name: "send_message",
      arguments: { target: "Cedar Creek", text: "radio check, how copy?" },
    }),
  );
  line(
    `${paint(C.green, "✓")} send_message → ${bold(sent.contact ?? "?")}: ` +
      `${bold(`"${sent.text}"`)} ${dim(short(sent.publicKey ?? ""))}`,
  );

  await h.cleanup();

  // -------------------------------------------------------------------------
  // 4. Live + provenance.
  // -------------------------------------------------------------------------
  header("Live traffic + provenance");
  // A fresh stack wired with a timeline: a seeded burst from Rocky Ridge, then
  // a decrypt-VERIFIED message on the public channel and an UNVERIFIED datagram
  // claiming the admin channel index (no key) — the adversarial input you cannot
  // safely produce on real hardware. We subscribe to the live resource, advance
  // the virtual clock, and watch update notifications arrive in compressed time.
  const burst = traffic.burst({ from: "rocky-ridge", count: 3, within: "10s", seed: SEED });
  const provenance = scenario([
    at("11s", { kind: "channelMessage", channel: 0, text: "net control: all stations green" }),
    at("12s", {
      kind: "channelMessage",
      channel: ADMIN_CH,
      text: "spoofed: reboot now",
      verified: false,
      snr: 7,
    }),
  ]);
  // Concatenate the two timelines into one scenario (scenario() re-sorts by `at`).
  const timeline = scenario([...burst.events, ...provenance.events]);

  const live = await wireStack(world, timeline);

  // Subscribe with a ResourceUpdatedNotification handler — exactly the MCP
  // push-notify flow. Count notifications in arrival order (deterministic).
  let updateCount = 0;
  live.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    if (n.params.uri === TRAFFIC_LIVE_URI) updateCount++;
  });
  await live.client.subscribeResource({ uri: TRAFFIC_LIVE_URI });
  line(dim(`subscribed to ${TRAFFIC_LIVE_URI}; advancing the clock through a burst…`));

  // Advance through the whole timeline; the harness settles autoSync between
  // fine steps, so each event is delivered near its own virtual fire time.
  await live.advance("13s");
  await flushMicrotasks();

  // Read the live resource back to display what landed (ordered by clock `at`).
  const { events } = readJson<{ events: TrafficEvent[] }>(
    await live.client.readResource({ uri: TRAFFIC_LIVE_URI }),
  );
  for (const ev of events) {
    if (ev.kind === "contact") {
      line(
        `${vt(ev.at)}  ${paint(C.green, "MESSAGE")}      ` +
          `${dim(short(ev.sender ?? "?"))} ${bold(`"${ev.text ?? ""}"`)}`,
      );
    } else if (ev.kind === "channel") {
      line(
        `${vt(ev.at)}  ${paint(C.green, "✓ VERIFIED")}   ` +
          `decrypt-verified on ${bold(`ch${ev.channelIdx} (public)`)}: ${bold(`"${ev.text ?? ""}"`)}`,
      );
    } else if (ev.kind === "channelData") {
      line(
        `${vt(ev.at)}  ${paint(C.yellow, "⚠ UNVERIFIED")} ` +
          `raw datagram on ${bold(`admin ch${ev.channelIdx}`)} ` +
          dim(`(snr ${ev.snr ?? "?"})`) +
          dim(", never decoded — no decryptVerified text is ever surfaced"),
      );
    }
  }

  // Prove the provenance distinction from the resource data itself.
  const verified = events.filter((e) => e.kind === "channel");
  const unverified = events.filter((e) => e.kind === "channelData");
  line(
    `${updateCount} live update notifications fired; ` +
      `${bold(String(verified.length))} verified channel message, ` +
      `${bold(String(unverified.length))} unverified datagram`,
  );
  const leaked = events.some((e) => e.decryptVerified && e.channelIdx === ADMIN_CH);
  line(
    dim("the admin-gate point: ") +
      (leaked
        ? paint(C.red, "FAILED — an admin-channel event surfaced as verified!")
        : paint(C.green, "the unverified admin datagram never appears as a verified channel message.")),
  );

  await live.cleanup();

  // -------------------------------------------------------------------------
  // 5. Admin: dry-run preview, then a scripted exec.
  // -------------------------------------------------------------------------
  header("Admin: dry-run preview, then a scripted exec");
  // First, a dry-run: admin synthesizes the intent preview + risk tier WITHOUT
  // contacting the device. Then a real remote exec — we script the repeater's
  // CLI reply as a contactMessage from that node, call admin, and advance the
  // clock to deliver the reply while the call is pending.
  const replyScript = scenario([
    at("2s", { kind: "message", from: "rocky-ridge", text: "OK - rebooting in 3s" }),
  ]);
  const admin = await wireStack(world, replyScript);

  const preview = structured<{ command: string; tier: string; dryRun: boolean; preview?: string }>(
    await admin.client.callTool({
      name: "admin",
      arguments: { node: "Rocky Ridge", command: "reboot", dryRun: true },
    }),
  );
  line(
    `${paint(C.cyan, "DRY-RUN")} admin reboot ${bold("Rocky Ridge")} ` +
      `${dim(`[tier: ${preview.tier}]`)} ${dim("(touched nothing)")}`,
  );
  line(`    ${dim("↳")} ${preview.preview ?? ""}`);

  // The real exec: call admin, then deliver the scripted reply mid-flight.
  const pending = admin.client.callTool({
    name: "admin",
    arguments: { node: "Rocky Ridge", command: "reboot" },
  });
  await admin.advance("3s");
  const execRes = await pending;
  const exec = structured<{ command: string; via?: string; reply?: string; dryRun: boolean }>(execRes);
  line(
    `${paint(C.green, "EXEC")}    admin reboot ${bold("Rocky Ridge")} ` +
      `${dim(`[via: ${exec.via ?? "?"}]`)} → reply: ${bold(`"${exec.reply ?? ""}"`)}`,
  );
  line(dim("login → CliData → reply, collapsed into one tool call; the sim scripted the reply."));

  await admin.cleanup();

  // -------------------------------------------------------------------------
  // 6. Determinism.
  // -------------------------------------------------------------------------
  header("Determinism");
  line(
    `${paint(C.green, "✓")} this run used seed ${bold(String(SEED))}. ` +
      `Re-run with ${bold(`--seed ${SEED}`)} for byte-identical stdout.`,
  );
  line(
    dim(
      "every printed time is the VIRTUAL clock (t+SS.mmms), never wall-clock; " +
        "collections are sorted before printing — so the tour is fully reproducible.",
    ),
  );

  // -------------------------------------------------------------------------
  // done
  // -------------------------------------------------------------------------
  console.log("");
  console.log(
    bold(paint(C.green, "✓ tour complete")) +
      dim(" — the whole MCP surface, driven through a real Client, no radio."),
  );
}

main().catch((error: unknown) => {
  console.error(paint(C.red, `\n✗ demo failed: ${(error as Error).message ?? String(error)}`));
  process.exit(1);
});
