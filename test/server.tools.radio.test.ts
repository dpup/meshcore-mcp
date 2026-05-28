/**
 * set-radio unit correctness + fuzzy-input tolerance, through the full MCP stack.
 *
 * The device wire units are **kHz** for frequency and **Hz** for bandwidth
 * (confirmed against a live node: 869.618 MHz → 869618, 62.5 kHz → 62500). The
 * meshcore-mcp surface is MHz / kHz, so `set-radio` must scale *both* by 1000.
 * The earlier bug scaled only frequency, sending an invalid bandwidth → NACK.
 *
 * meshcore-sim ≥ 0.2.0 records `setRadioParams` args in `commandLog` and applies
 * them (reflected by `getSelfInfo`), so we can assert the device-native values
 * and the read-after-write round-trip — the test the underscored-param sim
 * couldn't provide before.
 */
import { channel, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { ADMIN_COMMANDS } from "../src/index.js";
import { makeSimServer } from "./helpers/sim-server.js";

function homeWorld() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" })],
    channels: [channel(0, "public")],
    contacts: [],
  });
}

/** The args meshcore-sim records for the most recent setRadioParams call. */
function lastSetRadio(sim: { commandsOf(m: string): { args: Record<string, unknown> }[] }) {
  const calls = sim.commandsOf("setRadioParams");
  return calls[calls.length - 1]?.args;
}

describe("set-radio units + fuzzy tolerance (full MCP stack)", () => {
  it("scales BOTH freq (MHz→kHz) and bw (kHz→Hz) to device-native wire units", async () => {
    const h = await makeSimServer({ world: homeWorld() });

    await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "set-radio", params: { freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 } },
    });

    // The regression: bw must be 62500 (Hz), not 62.5. freq 910525 (kHz).
    expect(lastSetRadio(h.sim)).toEqual({ radioFreq: 910_525, radioBw: 62_500, radioSf: 7, radioCr: 5 });

    await h.cleanup();
  });

  it("round-trips: get_node_health reads back the values it wrote, in MHz/kHz", async () => {
    const h = await makeSimServer({ world: homeWorld() });

    await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "set-radio", params: { freqMhz: 915, bwKhz: 250, sf: 9, cr: 6 } },
    });
    const res = await h.client.callTool({ name: "get_node_health", arguments: {} });
    const radio = (res.structuredContent as { radio?: Record<string, number> }).radio;

    expect(radio?.freqMhz).toBe(915);
    expect(radio?.bwKhz).toBe(250);
    expect(radio?.sf).toBe(9);
    expect(radio?.cr).toBe(6);

    await h.cleanup();
  });

  it("tolerates fuzzy LLM inputs (kHz/Hz numbers, 'SF7', '4/5') → same wire units", async () => {
    const h = await makeSimServer({ world: homeWorld() });

    await h.client.callTool({
      name: "admin",
      arguments: {
        node: "Base",
        command: "set-radio",
        // freq as kHz, bw as Hz, sf/cr as strings — what a fuzzy call looks like.
        params: { freqMhz: 910_525, bwKhz: 62_500, sf: "SF7", cr: "4/5" },
      },
    });

    expect(lastSetRadio(h.sim)).toEqual({ radioFreq: 910_525, radioBw: 62_500, radioSf: 7, radioCr: 5 });

    await h.cleanup();
  });

  it("the registry's set-radio schema coerces the same way in isolation", () => {
    const parsed = ADMIN_COMMANDS["set-radio"]!.params.parse({
      freqMhz: "910.525 MHz",
      bwKhz: "62500",
      sf: "7",
      cr: "4/5",
    });
    expect(parsed).toEqual({ freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 });
  });
});
