/**
 * Full-stack tests for the contact-management tools added in 0.1.5:
 * import_contact, export_contact, share_contact, remove_contact, reset_path,
 * set_contact_path, set_auto_add_contacts. All wrap companion-protocol
 * commands on the local node — no remote dispatch.
 *
 * The sim records every call with its args; we assert via `commandsOf` that
 * the right method was reached and that the args were normalised correctly
 * (pubkey lowercased, path hex parsed).
 */
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function buildWorld() {
  return defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base" }),
      node("rocky-ridge", { name: "Rocky", role: "repeater" }),
    ],
    channels: [channel(0, "public")],
    contacts: [contact("Rocky", "rocky-ridge")],
  });
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

function structured<T>(res: unknown): T {
  const r = res as ToolResult;
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent).toBeDefined();
  return r.structuredContent as T;
}

function text(res: unknown): string {
  return (res as ToolResult).content?.[0]?.text ?? "";
}

describe("contact-management tools through the MCP stack", () => {
  it("import_contact accepts hex bytes and forwards them to the device", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const advertHex = "deadbeef".repeat(8); // 32 bytes
    const res = await h.client.callTool({
      name: "import_contact",
      arguments: { advertHex },
    });
    const out = structured<{ imported: true; lengthBytes: number }>(res);
    expect(out.imported).toBe(true);
    expect(out.lengthBytes).toBe(32);

    const calls = h.sim.commandsOf("importContact");
    expect(calls.length).toBe(1);
    const args = calls[0]?.args as { advertPacketBytes: Uint8Array };
    expect(args.advertPacketBytes).toBeInstanceOf(Uint8Array);
    expect(args.advertPacketBytes.length).toBe(32);

    await h.cleanup();
  });

  it("import_contact rejects non-hex input at the schema layer", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    const res = (await h.client.callTool({
      name: "import_contact",
      arguments: { advertHex: "not-hex!" },
    })) as ToolResult;
    // Zod input-schema validation rejects before the handler runs; no
    // importContact call should have reached the sim.
    expect(h.sim.commandsOf("importContact").length).toBe(0);
    // Either MCP-level error or tool isError — both are valid failure modes
    // for a schema rejection; just confirm we did NOT silently succeed.
    expect(res.structuredContent).toBeUndefined();
    await h.cleanup();
  });

  it("export_contact with no target exports the home node", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "export_contact",
      arguments: {},
    });
    const out = structured<{ name: string; publicKey: string; advertHex: string }>(res);
    expect(out.name).toBe("Base");
    expect(out.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // Sim returns 0 bytes for the export — we just verify the shape.
    expect(out.advertHex).toBe("");

    const calls = h.sim.commandsOf("exportContact");
    expect(calls.length).toBe(1);
    expect((calls[0]?.args as { pubKey?: string }).pubKey).toBeUndefined();

    await h.cleanup();
  });

  it("export_contact with a target resolves the contact and exports it", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "export_contact",
      arguments: { target: "Rocky" },
    });
    const out = structured<{ name: string; publicKey: string }>(res);
    expect(out.name).toBe("Rocky");
    expect(out.publicKey).toMatch(/^[0-9a-f]{64}$/);

    const calls = h.sim.commandsOf("exportContact");
    expect(calls.length).toBe(1);
    expect((calls[0]?.args as { pubKey?: string }).pubKey).toBe(out.publicKey);

    await h.cleanup();
  });

  it("export_contact on an unknown target is an actionable isError", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    const res = (await h.client.callTool({
      name: "export_contact",
      arguments: { target: "Ghost" },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Ghost");
    expect(h.sim.commandsOf("exportContact").length).toBe(0);
    await h.cleanup();
  });

  it("share_contact resolves the target and forwards to the device", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "share_contact",
      arguments: { target: "Rocky" },
    });
    structured<{ name: string; publicKey: string }>(res);

    const calls = h.sim.commandsOf("shareContact");
    expect(calls.length).toBe(1);
    expect((calls[0]?.args as { pubKey: string }).pubKey).toMatch(/^[0-9a-f]{64}$/);

    await h.cleanup();
  });

  it("remove_contact resolves the target and forwards to the device", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "remove_contact",
      arguments: { target: "Rocky" },
    });
    structured<{ name: string; publicKey: string }>(res);

    const calls = h.sim.commandsOf("removeContact");
    expect(calls.length).toBe(1);

    await h.cleanup();
  });

  it("reset_path resolves the target and forwards to the device", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "reset_path",
      arguments: { target: "Rocky" },
    });
    const out = structured<{ name: string; publicKey: string }>(res);
    expect(out.name).toBe("Rocky");

    const calls = h.sim.commandsOf("resetPath");
    expect(calls.length).toBe(1);
    expect(text(res).toLowerCase()).toContain("re-discover");

    await h.cleanup();
  });

  it("set_contact_path with explicit hops forwards the right path bytes", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "set_contact_path",
      arguments: { target: "Rocky", pathHex: "235f3a" },
    });
    const out = structured<{ name: string; pathHex: string }>(res);
    expect(out.pathHex).toBe("235f3a");

    // setContactPath calls addOrUpdateContact under the hood with the new
    // outPath bytes; the sim records that final call. outPath is the padded
    // 64-byte buffer (zero-padded after the actual hops).
    const calls = h.sim.commandsOf("addOrUpdateContact");
    expect(calls.length).toBe(1);
    const args = calls[0]?.args as { outPathLen: number; outPath: Uint8Array };
    expect(args.outPathLen).toBe(3);
    expect(Array.from(args.outPath.subarray(0, 3))).toEqual([0x23, 0x5f, 0x3a]);

    await h.cleanup();
  });

  it("set_contact_path with empty hex marks the contact as direct", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    const res = await h.client.callTool({
      name: "set_contact_path",
      arguments: { target: "Rocky", pathHex: "" },
    });
    const out = structured<{ pathHex: string }>(res);
    expect(out.pathHex).toBe("");
    expect(text(res).toLowerCase()).toContain("direct");

    const args = h.sim.commandsOf("addOrUpdateContact")[0]?.args as { outPathLen: number };
    expect(args.outPathLen).toBe(0);

    await h.cleanup();
  });

  it("set_contact_path rejects paths longer than 64 bytes", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    // 65 bytes = 130 hex chars
    const res = (await h.client.callTool({
      name: "set_contact_path",
      arguments: { target: "Rocky", pathHex: "ab".repeat(65) },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res).toLowerCase()).toContain("too long");
    expect(h.sim.commandsOf("addOrUpdateContact").length).toBe(0);
    await h.cleanup();
  });

  it("set_auto_add_contacts(true) calls setAutoAddContacts; (false) calls the manual variant", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    let res = await h.client.callTool({
      name: "set_auto_add_contacts",
      arguments: { autoAdd: true },
    });
    expect(structured<{ autoAdd: boolean }>(res).autoAdd).toBe(true);
    expect(h.sim.commandsOf("setAutoAddContacts").length).toBe(1);
    expect(h.sim.commandsOf("setManualAddContacts").length).toBe(0);

    res = await h.client.callTool({
      name: "set_auto_add_contacts",
      arguments: { autoAdd: false },
    });
    expect(structured<{ autoAdd: boolean }>(res).autoAdd).toBe(false);
    expect(h.sim.commandsOf("setManualAddContacts").length).toBe(1);
    // First call still recorded.
    expect(h.sim.commandsOf("setAutoAddContacts").length).toBe(1);

    await h.cleanup();
  });
});
