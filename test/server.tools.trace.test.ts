/**
 * trace_path — route trace + per-hop SNR. The sim records the path and returns
 * an empty trace, so we verify the path encoding (input) via commandLog and the
 * TraceData→result mapping (output) via a spy; plus the error paths.
 */
import type { TraceData } from "@dpup/meshcore-ts";
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it, vi } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" }), node("rocky", { name: "Rocky", role: "repeater" })],
    channels: [channel(0, "public")],
    contacts: [contact("Rocky", "rocky")],
  });
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}
const text = (r: ToolResult) => r.content?.[0]?.text ?? "";

describe("trace_path", () => {
  it("encodes a comma-separated hex path into the right hop bytes", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({ name: "trace_path", arguments: { path: "23,5f,3a" } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const sent = h.sim.commandsOf("tracePath").at(-1)?.args as { path: Uint8Array };
    expect(Array.from(sent.path)).toEqual([0x23, 0x5f, 0x3a]);
    await h.cleanup();
  });

  it("maps TraceData into paired hops + SNR", async () => {
    const h = await makeSimServer({ world: world() });
    const trace: TraceData = {
      pathLen: 2,
      flags: 0,
      tag: 1,
      authCode: 0,
      pathHashes: "235f",
      pathSnrs: [-7.5, -10],
      lastSnr: -10,
    };
    vi.spyOn(h.meshClient, "tracePath").mockResolvedValue(trace);

    const res = (await h.client.callTool({ name: "trace_path", arguments: { path: "235f" } })) as ToolResult;
    const out = res.structuredContent as { hopCount: number; hops: { hash: string; snr: number }[]; lastSnr: number };
    expect(out.hopCount).toBe(2);
    expect(out.hops).toEqual([
      { hash: "23", snr: -7.5 },
      { hash: "5f", snr: -10 },
    ]);
    expect(out.lastSnr).toBe(-10);
    expect(text(res)).toContain("→"); // the path arrow in the digest
    await h.cleanup();
  });

  it("reports hopCount from the hops actually returned, not the frame's pathLen", async () => {
    // A truncated/partial frame can declare a larger pathLen than it carries
    // per-hop SNRs; hopCount must follow the reported hops so the structured
    // count and the hops array can never disagree (the digest can't say
    // "3 hop(s)" while listing 2).
    const h = await makeSimServer({ world: world() });
    const trace: TraceData = {
      pathLen: 3,
      flags: 0,
      tag: 1,
      authCode: 0,
      pathHashes: "235f",
      pathSnrs: [-7.5, -10],
      lastSnr: -10,
    };
    vi.spyOn(h.meshClient, "tracePath").mockResolvedValue(trace);

    const res = (await h.client.callTool({ name: "trace_path", arguments: { path: "235f" } })) as ToolResult;
    const out = res.structuredContent as { hopCount: number; hops: { hash: string; snr: number }[] };
    expect(out.hops).toHaveLength(2);
    expect(out.hopCount).toBe(2);
    expect(out.hopCount).toBe(out.hops.length);
    await h.cleanup();
  });

  it("errors clearly when neither path nor node is given", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({ name: "trace_path", arguments: {} })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/needs a `?path`? .* or a `?node`?/i);
    await h.cleanup();
  });

  it("errors when a node has no known multi-hop path", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({ name: "trace_path", arguments: { node: "Rocky" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/no known multi-hop path/i);
    await h.cleanup();
  });
});
