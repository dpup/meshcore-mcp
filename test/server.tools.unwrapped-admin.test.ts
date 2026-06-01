/**
 * Smoke tests for the 7 unwrapped admin tools added in 0.1.5:
 * reboot_node, broadcast_advert, sync_clock, set_tx_power, set_radio,
 * set_node_name, set_node_location. They're thin top-level wrappers around
 * `MeshService.runAdmin` (back-compat with the multiplexed `admin` tool);
 * the deep dispatch behaviour (home-vs-remote, login, secret redaction,
 * preview synthesis) is exercised through the existing `admin` tests. Here
 * we verify:
 *   1. Each tool is discoverable in `tools.list` with per-command MCP
 *      annotations that match its risk tier.
 *   2. Omitting `node` targets the home node (the convenience the unwrap
 *      exists for).
 *   3. `dryRun: true` returns a preview with the right command name.
 *   4. The dispatch reaches the sim with the expected per-command call.
 */
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";
import { annotationsForTier, ADMIN_COMMANDS } from "../src/index.js";

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

interface ToolDef {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

describe("unwrapped admin tools through the MCP stack", () => {
  it("advertises per-command annotations matching each tier", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t: ToolDef) => [t.name, t] as const));

    // Each unwrapped tool's annotations = annotationsForTier(its command's
    // tier) + openWorldHint. Verify the mapping at every entry — this is the
    // entire point of unwrapping. Compare names rather than picking one
    // example so a regression on any single tool surfaces here.
    const pairs: Array<[string, string]> = [
      ["reboot_node", "reboot"],
      ["broadcast_advert", "advert"],
      ["sync_clock", "sync-time"],
      ["set_tx_power", "set-tx-power"],
      ["set_radio", "set-radio"],
      ["set_node_name", "set-name"],
      ["set_node_location", "set-location"],
    ];
    for (const [tool, cmd] of pairs) {
      const def = ADMIN_COMMANDS[cmd];
      const expected = annotationsForTier(def!.tier);
      const t = byName.get(tool);
      expect(t, `tool ${tool} should be registered`).toBeDefined();
      expect(t!.annotations?.readOnlyHint).toBe(expected.readOnlyHint);
      expect(t!.annotations?.destructiveHint).toBe(expected.destructiveHint);
      expect(t!.annotations?.idempotentHint).toBe(expected.idempotentHint);
      expect(t!.annotations?.openWorldHint).toBe(true);
    }

    await h.cleanup();
  });

  it("reboot_node with no node targets home via the structured client call", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({ name: "reboot_node", arguments: {} });
    const out = structured<{ command: string; via: string; dryRun: boolean }>(res);
    expect(out.command).toBe("reboot");
    expect(out.via).toBe("home");
    expect(out.dryRun).toBe(false);

    // The home dispatch maps to client.reboot() via the structured path.
    expect(h.sim.commandsOf("reboot").length).toBe(1);

    await h.cleanup();
  });

  it("set_tx_power forwards per-command params to the home structured call", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    await h.client.callTool({
      name: "set_tx_power",
      arguments: { dbm: 18 },
    });
    const calls = h.sim.commandsOf("setTxPower");
    expect(calls.length).toBe(1);
    expect((calls[0]?.args as { txPower: number }).txPower).toBe(18);

    await h.cleanup();
  });

  it("set_radio splices freqMhz/bwKhz/sf/cr into the home structured call", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    await h.client.callTool({
      name: "set_radio",
      arguments: { freqMhz: 910.525, bwKhz: 250, sf: 10, cr: 5 },
    });
    const calls = h.sim.commandsOf("setRadioParams");
    expect(calls.length).toBe(1);
    const args = calls[0]?.args as {
      radioFreq: number;
      radioBw: number;
      radioSf: number;
      radioCr: number;
    };
    // The home path scales MHz→kHz and kHz→Hz; verify the unwrap preserves it.
    expect(args.radioFreq).toBe(910525);
    expect(args.radioBw).toBe(250000);
    expect(args.radioSf).toBe(10);
    expect(args.radioCr).toBe(5);

    await h.cleanup();
  });

  it("dryRun: true returns a preview without contacting the device", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "reboot_node",
      arguments: { dryRun: true },
    });
    const out = structured<{ command: string; dryRun: boolean; preview?: string; via?: string }>(res);
    expect(out.dryRun).toBe(true);
    expect(out.command).toBe("reboot");
    expect(out.preview).toBeDefined();
    expect(out.preview).toContain("Base"); // the home node name
    expect(out.via).toBeUndefined();
    expect(h.sim.commandsOf("reboot").length).toBe(0);

    await h.cleanup();
  });

  it("explicit node targets a remote contact (admin sub-command back-compat)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    // Use the same dispatch as `admin Rocky reboot` but via the unwrapped
    // tool — confirms the back-compat claim that both paths reach the same
    // runAdmin code with identical behaviour. We assert dryRun: true to
    // avoid needing a responder script.
    const res = await h.client.callTool({
      name: "reboot_node",
      arguments: { node: "Rocky", dryRun: true },
    });
    const out = structured<{ preview?: string }>(res);
    expect(out.preview).toContain("Rocky");

    await h.cleanup();
  });

  it("sync_clock with no node syncs the home device time", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    await h.client.callTool({ name: "sync_clock", arguments: {} });
    // sync-time's home path calls client.syncDeviceTime() which the sim
    // records as setDeviceTime under the hood. Just verify SOMETHING in
    // the time-set family was called — we don't pin the exact sim record
    // name in case it shifts.
    const recorded = h.sim.commandsOf("setDeviceTime");
    expect(recorded.length).toBeGreaterThanOrEqual(1);

    await h.cleanup();
  });

  it("set_node_name forwards the name through the home structured call", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    await h.client.callTool({
      name: "set_node_name",
      arguments: { name: "NewBase" },
    });
    const calls = h.sim.commandsOf("setAdvertName");
    expect(calls.length).toBe(1);
    expect((calls[0]?.args as { name: string }).name).toBe("NewBase");

    await h.cleanup();
  });

  it("admin sub-command path still works (back-compat smoke)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    // The classic multiplexed path — same command, same dispatch, same
    // result shape as reboot_node. This is the back-compat promise.
    const res = await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "reboot" },
    });
    const out = structured<{ command: string; via: string }>(res);
    expect(out.command).toBe("reboot");
    expect(out.via).toBe("home");
    expect(h.sim.commandsOf("reboot").length).toBe(1);

    await h.cleanup();
  });
});
