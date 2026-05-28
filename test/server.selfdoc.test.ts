/**
 * The server is self-documenting in-protocol: an agent gets oriented from the
 * `initialize` instructions and from input/output schema descriptions in
 * `listTools` — no out-of-band docs needed. These assertions guard that surface.
 */
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { ADMIN_COMMANDS } from "../src/service/admin.js";
import { commandCatalogue } from "../src/tools/admin.js";
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

describe("admin command catalogue (built from public Zod surface)", () => {
  const catalogue = commandCatalogue();
  const lines = catalogue.split("\n");

  // Commands that actually take params — every such field must carry a real,
  // `.describe()`-sourced hint. The bare generic label (`": value"`) only ever
  // appears when `.description`/`.shape` extraction silently degrades (a Zod
  // internals rename) or when a new param is added with no `.describe(...)`.
  const commandsWithParams = Object.values(ADMIN_COMMANDS).filter((def) => {
    const shape = def.params instanceof Object && "shape" in def.params ? def.params.shape : undefined;
    return shape !== undefined && Object.keys(shape as Record<string, unknown>).length > 0;
  });

  it("lists every command with no degraded generic field hint", () => {
    // A line for each command, none containing the `": value"` fallback.
    for (const def of Object.values(ADMIN_COMMANDS)) {
      const line = lines.find((l) => l.includes(`• ${def.name} `));
      expect(line, `catalogue should list ${def.name}`).toBeDefined();
      expect(line, `${def.name} should not show the generic ": value" fallback`).not.toContain(": value");
    }
    // Sanity: there really are commands with params, so the guard has teeth.
    expect(commandsWithParams.length).toBeGreaterThan(0);
    expect(catalogue).not.toContain(": value");
  });

  it("surfaces the fuzzy-input unit hints from coerce.ts", () => {
    // set-tx-power's dbm and set-radio's freqMhz carry their unit guidance via
    // `.describe()`; their presence proves `.description` extraction is live.
    expect(catalogue).toContain("MHz"); // set-radio freqMhz
    expect(catalogue).toContain("dBm"); // set-tx-power dbm
  });
});
