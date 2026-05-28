/**
 * send_message confirm — wait for and report the delivery ack + round-trip for
 * direct messages. The sim acks every send (sendConfirmed) with a matching CRC,
 * so confirm resolves to delivered; the listener is armed before the send so the
 * sim's immediate microtask ack isn't raced past.
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

interface ToolResult { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] }

describe("send_message confirm (ack + RTT)", () => {
  it("reports delivery + round-trip for a confirmed contact send", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({
      name: "send_message",
      arguments: { target: "Rocky", text: "radio check", confirm: true },
    })) as ToolResult;
    const out = res.structuredContent as { delivered?: boolean; roundTripMs?: number; route?: string };
    expect(out.delivered).toBe(true);
    expect(typeof out.roundTripMs).toBe("number"); // 0 in the sim, but present
    expect(out.route).toMatch(/direct|flood/);
    expect(res.content?.[0]?.text ?? "").toMatch(/delivered \(ack/);
    await h.cleanup();
  });

  it("omits delivery fields when confirm is not requested (fire-and-forget)", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({
      name: "send_message",
      arguments: { target: "Rocky", text: "radio check" },
    })) as ToolResult;
    const out = res.structuredContent as { delivered?: boolean; confirmationNotApplicable?: boolean };
    expect(out.delivered).toBeUndefined();
    expect(out.confirmationNotApplicable).toBeUndefined();
    await h.cleanup();
  });

  it("a confirm:true CHANNEL send reports confirmationNotApplicable, not a bare absent `delivered`", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({
      name: "send_message",
      arguments: { target: "#public", text: "radio check", confirm: true },
    })) as ToolResult;
    const out = res.structuredContent as {
      kind?: string;
      delivered?: boolean;
      roundTripMs?: number;
      confirmationNotApplicable?: boolean;
    };
    expect(out.kind).toBe("channel");
    // The explicit, honest signal — not a silently-swallowed confirm.
    expect(out.confirmationNotApplicable).toBe(true);
    expect(out.delivered).toBeUndefined();
    expect(out.roundTripMs).toBeUndefined();
    // And the digest says so in plain language.
    expect(res.content?.[0]?.text ?? "").toMatch(/delivery acks apply to direct messages only/i);
    await h.cleanup();
  });

  it("a confirm:false channel send carries no confirmationNotApplicable flag", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({
      name: "send_message",
      arguments: { target: "#public", text: "radio check" },
    })) as ToolResult;
    const out = res.structuredContent as { confirmationNotApplicable?: boolean };
    expect(out.confirmationNotApplicable).toBeUndefined();
    await h.cleanup();
  });
});
