import {
  channel,
  contact,
  defineWorld,
  node,
  scenario,
  traffic,
  at,
} from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";
import type { MeshSurvey, NodeHealth } from "../src/index.js";

/**
 * The M2 done-when proof: drive the **full MCP stack** through a real `Client`
 * over the sim-backed harness, and assert on the **tool results** — never on
 * server internals (AGENTS.md, execution plan §5). One world serves every case:
 * a home node, a reachable repeater, and an unreachable one for the error path.
 */

/** The shared world: home + reachable repeater (Rocky) + offline repeater (Dead). */
function buildWorld() {
  return defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base", battery: 80 }),
      node("rocky-ridge", { name: "Rocky", role: "repeater", battery: 42 }),
      node("dead-node", { name: "Dead", role: "repeater", reachable: false }),
    ],
    channels: [channel(0, "public"), channel(7, "admin", { kind: "private" })],
    contacts: [
      contact("Rocky", "rocky-ridge"),
      contact("Dead", "dead-node"),
    ],
  });
}

/** A CallTool result, loosened for ergonomic assertion. */
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

/** Pull the structured payload off a CallTool result, asserting it succeeded. */
function structured<T>(res: unknown): T {
  const r = res as ToolResult;
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent).toBeDefined();
  return r.structuredContent as T;
}

/** The text digest off a CallTool result. */
function text(res: unknown): string {
  const first = (res as ToolResult).content?.[0];
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

describe("read tools through a real MCP Client over a sim-backed server", () => {
  it("get_node_health (home) returns the world's self/radio/battery/stats", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({ name: "get_node_health", arguments: {} });
    const health = structured<NodeHealth>(res);

    expect(health.kind).toBe("home");
    expect(health.node).toBe("Base");
    expect(health.reachable).toBe(true);
    expect(health.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // Radio config from SelfInfo (the US 910.525 MHz preset).
    expect(health.radio?.freqKhz).toBe(910_525);
    expect(health.radio?.sf).toBe(10);
    expect(health.radio?.cr).toBe(5);
    // Battery: 80% on the 3000..4200mV model = 3960mV.
    expect(health.battery?.milliVolts).toBe(3960);
    // Stats and device time are present.
    expect(health.stats).toBeDefined();
    expect(typeof health.deviceTimeMs).toBe("number");
    // The digest is a high-signal summary, not raw frames.
    expect(text(res)).toContain("Base");
    expect(text(res)).toContain("radio");

    await h.cleanup();
  });

  it("get_node_health (reachable remote) returns the repeater's status via login", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "get_node_health",
      arguments: { node: "Rocky" },
    });
    const health = structured<NodeHealth>(res);

    expect(health.kind).toBe("remote");
    expect(health.node).toBe("Rocky");
    expect(health.reachable).toBe(true);
    // 42% on the model = 3000 + 1200*0.42 = 3504 mV.
    expect(health.battery?.milliVolts).toBe(3504);
    expect(health.stats).toBeDefined();
    // Remote snapshots report telemetry only as an opaque byte length.
    expect(typeof health.telemetryBytes === "number" || health.telemetryBytes === undefined).toBe(
      true,
    );

    await h.cleanup();
  });

  it("get_node_health (unreachable) returns an actionable isError result, not a crash", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = (await h.client.callTool({
      name: "get_node_health",
      arguments: { node: "Dead" },
    })) as ToolResult;

    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("Dead");
    // High-signal: names the node and that it could not be reached.
    expect(msg.toLowerCase()).toContain("unreachable");

    await h.cleanup();
  });

  it("get_node_health resolves a node by hex public-key prefix", async () => {
    const world = buildWorld();
    const h = await makeSimServer({ world });

    // Take Rocky's key prefix from the survey, then health-check by prefix.
    const survey = structured<MeshSurvey>(
      await h.client.callTool({ name: "survey_mesh", arguments: {} }),
    );
    const rocky = survey.contacts.find((c) => c.name === "Rocky");
    expect(rocky).toBeDefined();
    const prefix = rocky!.publicKey.slice(0, 12);

    const res = await h.client.callTool({
      name: "get_node_health",
      arguments: { node: prefix },
    });
    const health = structured<NodeHealth>(res);
    expect(health.kind).toBe("remote");
    expect(health.publicKey).toBe(rocky!.publicKey);

    await h.cleanup();
  });

  it("survey_mesh returns the roster (home + contacts with last-heard)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({ name: "survey_mesh", arguments: {} });
    const survey = structured<MeshSurvey>(res);

    expect(survey.home.name).toBe("Base");
    expect(survey.home.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const names = survey.contacts.map((c) => c.name).sort();
    expect(names).toEqual(["Dead", "Rocky"]);
    for (const c of survey.contacts) {
      expect(c.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof c.lastHeardMs).toBe("number");
      expect(typeof c.role).toBe("number");
    }
    expect(text(res)).toContain("Rocky");

    await h.cleanup();
  });

  it("get_recent_traffic returns buffered events after advancing the clock", async () => {
    const scn = traffic.burst({ from: "rocky-ridge", count: 3, within: "10s", seed: 7 });
    const h = await makeSimServer({ world: buildWorld(), scenario: scn });

    // Advance virtual time through the burst; the harness settles autoSync.
    await h.advance("12s");

    const all = structured<{ events: Array<{ kind: string; text?: string; at: number }>; count: number }>(
      await h.client.callTool({ name: "get_recent_traffic", arguments: {} }),
    );
    const contactEvents = all.events.filter((e) => e.kind === "contact");
    expect(contactEvents).toHaveLength(3);
    // Provenance/text is preserved through the full stack.
    for (const e of contactEvents) {
      expect(typeof e.text).toBe("string");
    }
    expect(text(await h.client.callTool({ name: "get_recent_traffic", arguments: {} }))).toContain("event");

    // `since` (virtual-clock ms number) windows to the later events.
    const lastAt = Math.max(...contactEvents.map((e) => e.at));
    const windowed = structured<{ events: Array<{ at: number }>; count: number }>(
      await h.client.callTool({
        name: "get_recent_traffic",
        arguments: { since: lastAt },
      }),
    );
    expect(windowed.count).toBeGreaterThanOrEqual(1);
    for (const e of windowed.events) {
      expect(e.at).toBeGreaterThanOrEqual(lastAt);
    }

    await h.cleanup();
  });

  it("get_recent_traffic distinguishes verified vs unverified channel traffic", async () => {
    const scn = scenario([
      at("2s", { kind: "channelMessage", channel: 0, text: "all green", verified: true }),
      at("3s", { kind: "channelMessage", channel: 7, text: "secret", verified: false, snr: 7 }),
    ]);
    const h = await makeSimServer({ world: buildWorld(), scenario: scn });

    await h.advance("5s");

    const { events } = structured<{
      events: Array<{ kind: string; channelIdx?: number; decryptVerified: boolean; text?: string }>;
    }>(await h.client.callTool({ name: "get_recent_traffic", arguments: {} }));

    const verified = events.find((e) => e.kind === "channel");
    expect(verified?.decryptVerified).toBe(true);
    expect(verified?.text).toBe("all green");

    const unverified = events.find((e) => e.kind === "channelData");
    expect(unverified?.decryptVerified).toBe(false);
    expect(unverified?.channelIdx).toBe(7);
    expect(unverified?.text).toBeUndefined();

    await h.cleanup();
  });

  it("the read tools advertise read-only / idempotent / open-world annotations", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    // The read tools are present (M3 adds the action tools to the same server).
    expect(names).toEqual(
      expect.arrayContaining(["get_node_health", "get_recent_traffic", "survey_mesh"]),
    );

    const readToolNames = new Set(["get_node_health", "get_recent_traffic", "survey_mesh"]);
    for (const t of tools.filter((t) => readToolNames.has(t.name))) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.idempotentHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(true);
    }

    await h.cleanup();
  });
});
