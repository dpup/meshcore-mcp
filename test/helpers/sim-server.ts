/**
 * The reusable full-stack harness — the centre of gravity for every M2+ test
 * (AGENTS.md, execution plan §1, §5). It wires the whole seam in one process,
 * no hardware, no sockets:
 *
 * ```
 * MCP Client ⟷ InMemoryTransport ⟷ McpServer(createServer({service}))
 *               → MeshService → MeshCoreClient → SimConnection → world+SimClock
 * ```
 *
 * A test builds a world (+ optional scenario), calls {@link makeSimServer}, and
 * asserts on the **tool result** through a real MCP `Client` — never on server
 * internals.
 *
 * ### autoSync timing
 *
 * Carried over from M1: under `autoSync`, the client drains queued messages on
 * **microtasks after `clock.advance()` returns**, when `clock.now()` already
 * equals the step's end. So advancing in one big jump collapses every event's
 * `at` stamp onto that far instant. {@link SimServer.advance} steps the virtual
 * clock in fine increments with a bounded microtask flush between each, so each
 * event is observed (and stamped) near its own fire time and traffic delivery
 * settles deterministically before assertions.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import {
  SimClock,
  SimConnection,
  toMillis,
} from "@dpup/meshcore-sim";
import type { MeshWorld, Responder, Scenario } from "@dpup/meshcore-sim";

import { createServer } from "../../src/server.js";
import { MeshService } from "../../src/service/mesh-service.js";
import type { CredentialsProvider } from "../../src/service/mesh-service.js";
import type { CredentialStore } from "../../src/store/credential-store.js";
import {
  composeCredentials,
  InMemoryCredentialStore,
} from "../../src/store/credential-store.js";

/** Options for {@link makeSimServer}. */
export interface MakeSimServerOptions {
  /** The simulated world (built with `defineWorld`). */
  world: MeshWorld;
  /** An optional timeline driving live traffic / node-state changes. */
  scenario?: Scenario;
  /** An optional pre-built clock; one is created if omitted. */
  clock?: SimClock;
  /** Per-node login credentials for the remote-health path (default guest). */
  credentials?: CredentialsProvider;
  /**
   * The runtime-managed credential store the `set_credential` /
   * `forget_credential` tools write through. Defaults to a fresh
   * {@link InMemoryCredentialStore} — a clean per-test slate, no disk I/O.
   * Tests that exercise the layering pass their own store so they can
   * inspect/preload entries.
   */
  credentialStore?: CredentialStore;
  /** Reactive-reply rules (meshcore-sim ≥ 0.2.0) — e.g. a remote-admin CLI reply. */
  responders?: Responder[];
}

/** The wired full stack plus teardown, returned by {@link makeSimServer}. */
export interface SimServer {
  /** A real MCP `Client` linked to the server over an in-memory transport. */
  client: Client;
  /** The `McpServer` under test. */
  server: McpServer;
  /** The device-facing core the tools call. */
  service: MeshService;
  /** The virtual clock the whole stack shares. */
  clock: SimClock;
  /** The simulated connection backing the `MeshCoreClient`. */
  sim: SimConnection;
  /** The `MeshCoreClient` driven by the sim — `vi.spyOn` it to inject device errors. */
  meshClient: MeshCoreClient;
  /**
   * The credential store wired into the service. Tests that exercise the
   * `set_credential` / `forget_credential` tools or the credential layering
   * can inspect/preload it directly.
   */
  credentialStore: CredentialStore;
  /**
   * Advance the virtual clock by `by` (a `Duration`), stepping in fine
   * increments with a bounded microtask flush between each so `autoSync` traffic
   * settles and each event is stamped near its own fire time.
   */
  advance(by: string | number): Promise<void>;
  /** Flush the microtask queue (the client's async drain chain). */
  flush(times?: number): Promise<void>;
  /** Close the client and server. */
  cleanup(): Promise<void>;
}

/**
 * Flush the microtask queue enough times for the client's drain chain to fully
 * settle. The `MsgWaiting → getWaitingMessages() → emit` drain is async and
 * re-entrant, spanning many microtask turns; a generous bounded loop drains it
 * deterministically without touching real time.
 */
async function flushMicrotasks(times = 64): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Build the full sim-backed MCP stack and link a real `Client` to it.
 *
 * @example
 * ```ts
 * const h = await makeSimServer({ world, scenario });
 * await h.advance("10s");
 * const res = await h.client.callTool({ name: "get_recent_traffic" });
 * await h.cleanup();
 * ```
 */
export async function makeSimServer(opts: MakeSimServerOptions): Promise<SimServer> {
  const clock = opts.clock ?? new SimClock();
  const sim = new SimConnection({
    world: opts.world,
    clock,
    scenario: opts.scenario,
    responders: opts.responders,
  });
  const meshClient = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  // The credential store default lives at the call site (here), not in
  // MeshService — so the seam is explicit, matching the Clock pattern.
  const credentialStore = opts.credentialStore ?? new InMemoryCredentialStore();
  // Same layering helper production uses (cli.ts) — store wins, then the
  // optional env baseline; lock-step prod/test precedence.
  const credentials: CredentialsProvider = composeCredentials(
    credentialStore,
    opts.credentials,
  );
  const service = new MeshService(meshClient, clock, {
    credentials,
    credentialStore,
  });
  await service.start();

  const server = createServer({ service });
  const client = new Client({ name: "sim-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  /** Fine-step advance: 250ms slices keep each event near its own fire time. */
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
    // A final flush in case totalMs was zero or an exact multiple settled late.
    await flushMicrotasks();
  }

  async function cleanup(): Promise<void> {
    await client.close();
    await server.close();
    await service.stop();
  }

  return {
    client,
    server,
    service,
    clock,
    sim,
    meshClient,
    credentialStore,
    advance,
    flush: flushMicrotasks,
    cleanup,
  };
}
