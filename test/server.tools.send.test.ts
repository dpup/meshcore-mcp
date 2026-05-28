/**
 * H4 — a message sent through this server is recorded in the traffic buffer
 * (direction "out"), so it shows in `get_recent_traffic` / the live stream
 * (the device serves no sent-message history; this is our own session record).
 * H6 — a `#`-prefixed target that resolves to no channel returns a
 * channel-aware error listing known channels, not "No contact matches … unreachable".
 */
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

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

describe("send_message: outbound recording (H4) + channel-aware errors (H6)", () => {
  it("records a sent channel message as outbound, visible in get_recent_traffic", async () => {
    const h = await makeSimServer({ world: world() });

    await h.client.callTool({ name: "send_message", arguments: { target: "#public", text: "radio check" } });
    const res = (await h.client.callTool({ name: "get_recent_traffic", arguments: {} })) as ToolResult;
    const events = (res.structuredContent as { events: { direction?: string; kind: string; text?: string }[] }).events;

    const sent = events.find((e) => e.direction === "out");
    expect(sent).toBeDefined();
    expect(sent?.kind).toBe("channel");
    expect(sent?.text).toBe("radio check");
    expect(text(res)).toContain("→"); // the outbound arrow in the digest

    await h.cleanup();
  });

  it("records a sent contact message as outbound too", async () => {
    const h = await makeSimServer({ world: world() });
    await h.client.callTool({ name: "send_message", arguments: { target: "Rocky", text: "ping" } });
    const res = (await h.client.callTool({ name: "get_recent_traffic", arguments: {} })) as ToolResult;
    const events = (res.structuredContent as { events: { direction?: string; kind: string; text?: string }[] }).events;
    expect(events.some((e) => e.direction === "out" && e.kind === "contact" && e.text === "ping")).toBe(true);
    await h.cleanup();
  });

  it("an unknown #channel returns a channel-aware error listing known channels — not 'unreachable'", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({ name: "send_message", arguments: { target: "#nope", text: "x" } })) as ToolResult;

    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toMatch(/no channel matches "#nope"/i);
    expect(msg).toContain("#public"); // lists what IS available
    expect(msg).not.toMatch(/unreachable/i);
    expect(msg).not.toMatch(/no contact matches/i);

    await h.cleanup();
  });
});
