/**
 * The server is self-documenting in-protocol: an agent gets oriented from the
 * `initialize` instructions and from input/output schema descriptions in
 * `listTools` — no out-of-band docs needed. These assertions guard that surface.
 */
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" })],
    channels: [channel(0, "public")],
    contacts: [contact("Rocky", "base")],
  });
}

describe("self-documenting MCP surface", () => {
  it("returns server instructions at initialize (trust model + key conventions)", async () => {
    const h = await makeSimServer({ world: world() });
    const instr = h.client.getInstructions() ?? "";
    expect(instr).toContain("ungated"); // the trust model an agent must know
    expect(instr).toContain("dryRun"); // the admin-preview discipline
    expect(instr.toLowerCase()).toContain("mhz"); // the unit convention
    expect(instr).toContain("decryptVerified"); // the provenance caveat
    await h.cleanup();
  });

  it("carries input + output schema descriptions on the tools", async () => {
    const h = await makeSimServer({ world: world() });
    const tools = (await h.client.listTools()).tools;

    const health = tools.find((t) => t.name === "get_node_health");
    // input param documented…
    const nodeProp = (health?.inputSchema.properties as Record<string, { description?: string }>).node;
    expect(nodeProp?.description ?? "").toMatch(/home node/i);
    // …and output units documented.
    const radio = (health?.outputSchema?.properties as Record<string, { properties?: Record<string, { description?: string }> }>)
      ?.radio?.properties;
    expect(radio?.freqMhz?.description).toMatch(/MHz/);

    const send = tools.find((t) => t.name === "send_message");
    const target = (send?.inputSchema.properties as Record<string, { description?: string }>).target;
    expect(target?.description ?? "").toMatch(/contact|channel/i);

    await h.cleanup();
  });
});
