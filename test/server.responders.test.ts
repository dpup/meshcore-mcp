/**
 * meshcore-sim ≥ 0.2.0 capabilities, exercised through the full MCP stack:
 *
 * - **Reactive replies** (`responders`) — a remote `admin` command (`login` →
 *   `CliData` text → reply) round-trips against the sim instead of timing out;
 *   the addressed node answers and the reply comes back as the tool result.
 * - **Observable writes** (`SimConnection.commandLog`) — we can assert the app
 *   actually sent the login and the CLI command, not just that the call resolved.
 */
import { TxtType } from "@dpup/meshcore-ts";
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import type { Responder } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

/** The slice of a `callTool` result these tests assert on. */
interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
}

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [
      node("base", { name: "Base" }),
      node("rocky", { name: "Rocky", role: "repeater" }),
    ],
    channels: [channel(0, "public")],
    contacts: [contact("Rocky", "rocky")],
  });
}

/** Answer any CliData command as the addressed node — the remote-admin reply. */
const cliResponder: Responder = {
  when: (m) => m.kind === "contact" && m.txtType === TxtType.CliData,
  reply: (m) => (m.to === undefined ? undefined : { from: m.to, text: `OK - ${m.text}`, after: "1s" }),
};

describe("meshcore-sim 0.2.0: responders + commandLog through the MCP stack", () => {
  it("remote admin exec round-trips via a reactive reply", async () => {
    const h = await makeSimServer({ world: world(), responders: [cliResponder] });

    // The call blocks on the reply; advance the clock to let the responder fire.
    const pending = h.client.callTool({
      name: "admin",
      arguments: { node: "Rocky", command: "reboot" },
    });
    await h.advance("3s");
    const res = (await pending) as ToolResult;

    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { via?: string; reply?: string; dryRun?: boolean };
    expect(out.dryRun).toBe(false);
    expect(out.via).toBe("remote");
    expect(out.reply).toBe("OK - reboot");

    await h.cleanup();
  });

  it("records the login + CliData send in the command log (observable writes)", async () => {
    const h = await makeSimServer({ world: world(), responders: [cliResponder] });

    const pending = h.client.callTool({
      name: "admin",
      arguments: { node: "Rocky", command: "reboot" },
    });
    await h.advance("3s");
    await pending;

    // The app logged in to Rocky, then sent "reboot" as a CliData text message.
    expect(h.sim.commandsOf("login").some((c) => c.args.to === "rocky")).toBe(true);
    const sends = h.sim.commandsOf("sendTextMessage");
    expect(
      sends.some((c) => c.args.to === "rocky" && c.args.text === "reboot" && c.args.txtType === TxtType.CliData),
    ).toBe(true);

    await h.cleanup();
  });
});
