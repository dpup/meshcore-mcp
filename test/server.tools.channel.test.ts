/**
 * Channel discovery (`meshcore://channels`) + add (`set_channel`) through the
 * full MCP stack. The sim records `setChannel` in `commandLog`, so we can assert
 * the device received the right slot/name/key — including a generated random key
 * and a next-free slot.
 */
import { channel, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" })],
    channels: [channel(0, "public")],
    contacts: [],
  });
}

describe("channels: list + add (full MCP stack)", () => {
  it("lists configured channels via the meshcore://channels resource", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.readResource({ uri: "meshcore://channels" });
    const body = JSON.parse((res.contents[0] as { text: string }).text) as {
      channels: { index: number; name: string }[];
    };
    expect(body.channels.some((c) => c.index === 0 && c.name === "public")).toBe(true);
    await h.cleanup();
  });

  it("set_channel with an explicit key/slot reaches the device verbatim", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.callTool({
      name: "set_channel",
      arguments: { name: "ops", secret: "00112233445566778899aabbccddeeff", index: 3 },
    });
    expect((res.structuredContent as { index: number }).index).toBe(3);
    const sent = h.sim.commandsOf("setChannel").at(-1)?.args;
    expect(sent).toEqual({ channelIdx: 3, name: "ops", secret: "00112233445566778899aabbccddeeff" });
    await h.cleanup();
  });

  it("set_channel with no secret/index generates a random key in the next free slot", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.callTool({ name: "set_channel", arguments: { name: "random" } });
    const out = res.structuredContent as { index: number; secret: string };
    expect(out.index).toBe(1); // slot 0 is taken by "public"
    expect(out.secret).toMatch(/^[0-9a-f]{32}$/);
    const sent = h.sim.commandsOf("setChannel").at(-1)?.args as { channelIdx: number; secret: string };
    expect(sent.channelIdx).toBe(1);
    expect(sent.secret).toBe(out.secret);
    await h.cleanup();
  });
});
