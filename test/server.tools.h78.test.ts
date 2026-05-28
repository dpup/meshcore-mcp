/**
 * H7 — delete_channel removes a slot (by index or name). H8 — an unknown admin
 * command returns a friendly, actionable message (the valid list), not raw Zod
 * enum JSON.
 */
import { channel, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" })],
    channels: [channel(0, "public"), channel(3, "ops")],
    contacts: [],
  });
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}
const text = (r: ToolResult) => r.content?.[0]?.text ?? "";

describe("H7: delete_channel", () => {
  it("deletes by index, reaching the device with the right slot", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({ name: "delete_channel", arguments: { index: 3 } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { index: number }).index).toBe(3);
    expect(h.sim.commandsOf("deleteChannel").at(-1)?.args).toEqual({ channelIdx: 3 });
    await h.cleanup();
  });

  it("deletes by name, resolving the slot first", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({ name: "delete_channel", arguments: { name: "ops" } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { index: number }).index).toBe(3);
    expect(h.sim.commandsOf("deleteChannel").at(-1)?.args).toEqual({ channelIdx: 3 });
    await h.cleanup();
  });
});

describe("H8: friendly admin validation error", () => {
  it("an unknown admin command returns the valid list, not raw Zod JSON", async () => {
    const h = await makeSimServer({ world: world() });
    const res = (await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "set-channel" }, // not a real admin command
    })) as ToolResult;

    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toMatch(/unknown admin command "set-channel"/i);
    expect(msg).toMatch(/known commands:/i);
    expect(msg).toContain("reboot"); // names a real one from the list
    expect(msg).not.toContain("invalid_enum_value"); // no raw Zod JSON
    await h.cleanup();
  });
});
