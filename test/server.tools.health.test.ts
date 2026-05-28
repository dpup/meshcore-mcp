/**
 * `get_node_health` graceful degradation under transient device failures (H1+H3).
 *
 * The real node intermittently times out on a companion sub-call; previously a
 * single sub-call timeout failed the entire snapshot and mislabeled it
 * "unreachable." Now the service retries (clock-driven) and, when a sub-call
 * still fails, returns a **partial** snapshot listing which fields are absent in
 * `degraded` — `reachable` stays `true` because `getSelfInfo` succeeded.
 */
import { MeshCoreTimeoutError } from "@dpup/meshcore-ts";
import { channel, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it, vi } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" })],
    channels: [channel(0, "public")],
    contacts: [],
  });
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}

describe("get_node_health resilience (H1+H3)", () => {
  it("retries a transient sub-call timeout and returns a complete snapshot", async () => {
    const h = await makeSimServer({ world: world() });
    // Make getStatsCore reject *once* (a flake), then defer to the sim.
    const spy = vi
      .spyOn(h.meshClient, "getStatsCore")
      .mockRejectedValueOnce(new MeshCoreTimeoutError());

    const pending = h.client.callTool({ name: "get_node_health", arguments: {} });
    // The first failure triggers a 200ms backoff (clock-driven); advance the
    // virtual clock through it so the retry fires.
    await h.advance("500ms");
    const res = (await pending) as ToolResult;

    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(2); // 1 reject + 1 successful retry
    const snap = res.structuredContent as { degraded?: string[]; uptimeSecs?: number };
    expect(snap.degraded).toBeUndefined(); // retry succeeded → no degradation
    expect(typeof snap.uptimeSecs).toBe("number");

    await h.cleanup();
  });

  it("degrades gracefully when a sub-call fails after all retries — no 'unreachable' lie", async () => {
    const h = await makeSimServer({ world: world() });
    // Persistent failure on one sub-call; the others succeed.
    vi.spyOn(h.meshClient, "getStatsCore").mockRejectedValue(new MeshCoreTimeoutError());

    const pending = h.client.callTool({ name: "get_node_health", arguments: {} });
    await h.advance("3s"); // covers 200ms + 400ms backoffs across the 3 attempts
    const res = (await pending) as ToolResult;

    expect(res.isError).toBeFalsy(); // partial, not unreachable
    const snap = res.structuredContent as {
      reachable: boolean;
      degraded?: string[];
      uptimeSecs?: number;
      stats?: { lastRssi?: number };
      battery?: unknown;
    };
    expect(snap.reachable).toBe(true);
    expect(snap.degraded).toEqual(["statsCore"]);
    expect(snap.uptimeSecs).toBeUndefined(); // statsCore is the source of uptimeSecs
    expect(snap.battery).toBeDefined(); // a different sub-call — still present
    expect(snap.stats?.lastRssi).toBeDefined(); // from statsRadio — still present
    // The digest text mentions the partial state.
    expect(res.content?.[0]?.text ?? "").toMatch(/partial:.*statsCore/);

    await h.cleanup();
  });

  it("retries a flaky getSelfInfo (no spurious 'unreachable' for one timeout)", async () => {
    const h = await makeSimServer({ world: world() });
    const spy = vi
      .spyOn(h.meshClient, "getSelfInfo")
      .mockRejectedValueOnce(new MeshCoreTimeoutError());

    const pending = h.client.callTool({ name: "get_node_health", arguments: {} });
    await h.advance("500ms");
    const res = (await pending) as ToolResult;

    expect(res.isError).toBeFalsy();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);

    await h.cleanup();
  });
});
