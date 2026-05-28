/**
 * Argument completion + the help resource + the per-node resource template —
 * the dynamic, discoverable half of the self-documenting surface. MCP completes
 * **prompt arguments** and **resource-template variables** (not tool args), so
 * node-name completion lives on the `diagnose-quiet-node` prompt and the
 * `meshcore://node/{node}` template.
 */
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [
      node("base", { name: "Base" }),
      node("rocky", { name: "Rocky Ridge", role: "repeater", battery: 80 }),
      node("cedar", { name: "Cedar Creek" }),
    ],
    channels: [channel(0, "public")],
    contacts: [contact("Rocky Ridge", "rocky"), contact("Cedar Creek", "cedar")],
  });
}

describe("completions + help (discoverable surface)", () => {
  it("completes a prompt's node argument with live node names", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.complete({
      ref: { type: "ref/prompt", name: "diagnose-quiet-node" },
      argument: { name: "node", value: "Roc" },
    });
    expect(res.completion.values).toContain("Rocky Ridge");
    expect(res.completion.values).not.toContain("Cedar Creek");
    await h.cleanup();
  });

  it("completes the meshcore://node/{node} template variable", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.complete({
      ref: { type: "ref/resource", uri: "meshcore://node/{node}" },
      argument: { name: "node", value: "Ced" },
    });
    expect(res.completion.values).toContain("Cedar Creek");
    await h.cleanup();
  });

  it("reads one node's health via the meshcore://node/{node} resource", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.readResource({ uri: "meshcore://node/Rocky%20Ridge" });
    const body = JSON.parse((res.contents[0] as { text: string }).text) as {
      node?: string;
      kind?: string;
      battery?: { milliVolts: number; volts?: number; percent?: number };
    };
    expect(body.node).toBe("Rocky Ridge");
    expect(body.kind).toBe("remote");
    // The resource must surface the presentation-projected battery (volts/percent),
    // not the raw service shape (millivolts only). Battery 80% ⇒ 3960mV ⇒ ~73%
    // (mirrors the friendly test); guards against the resource regressing to the
    // raw `NodeHealth`.
    expect(body.battery?.milliVolts).toBe(3960);
    expect(body.battery?.volts).toBeCloseTo(3.96, 3);
    expect(typeof body.battery?.percent).toBe("number");
    expect(body.battery?.percent).toBe(73);
    await h.cleanup();
  });

  it("serves a help document that reuses the live admin catalogue", async () => {
    const h = await makeSimServer({ world: world() });
    const res = await h.client.readResource({ uri: "meshcore://help" });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain("# meshcore-mcp");
    expect(text).toContain("## Admin commands");
    expect(text).toContain("set-radio"); // from the generated catalogue
    expect(text).toContain("## Recipes");
    await h.cleanup();
  });
});
