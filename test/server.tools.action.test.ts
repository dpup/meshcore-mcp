import {
  at,
  channel,
  contact,
  defineWorld,
  node,
  scenario,
} from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";
import { ADMIN_COMMANDS, annotationsForTier } from "../src/index.js";
import type { AdminResult, SendMessageResult } from "../src/index.js";

/**
 * The M3 done-when proof: drive the **action** surface — `send_message` and the
 * enumerated `admin` tool — through a real MCP `Client` over the sim-backed
 * harness, asserting on tool results (AGENTS.md, execution plan §3/§5). One
 * world serves the full-stack cases: a home node, a reachable repeater, and an
 * unreachable one for the error path.
 */

/** The shared world: home + reachable repeater (Rocky) + offline repeater (Dead). */
function buildWorld() {
  return defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base", battery: 80 }),
      node("rocky-ridge", { name: "Rocky", role: "repeater", battery: 42 }),
      node("dead-node", { name: "Dead", role: "repeater", reachable: false }),
    ],
    channels: [channel(0, "public"), channel(7, "admin", { kind: "private" })],
    contacts: [contact("Rocky", "rocky-ridge"), contact("Dead", "dead-node")],
  });
}

/** A CallTool result, loosened for ergonomic assertion. */
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

/** Pull the structured payload off a CallTool result, asserting it succeeded. */
function structured<T>(res: unknown): T {
  const r = res as ToolResult;
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent).toBeDefined();
  return r.structuredContent as T;
}

/** The text digest off a CallTool result. */
function text(res: unknown): string {
  const first = (res as ToolResult).content?.[0];
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

describe("action tools through a real MCP Client over a sim-backed server", () => {
  it("send_message to a contact reflects the send (sim resolves + acks)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "send_message",
      arguments: { target: "Rocky", text: "ping" },
    });
    const sent = structured<SendMessageResult>(res);

    expect(sent.kind).toBe("contact");
    expect(sent.contact).toBe("Rocky");
    expect(sent.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.text).toBe("ping");
    expect(text(res)).toContain("ping");

    await h.cleanup();
  });

  it("admin dry-run returns a preview + destructive tier, touching nothing", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "admin",
      arguments: { node: "Rocky", command: "reboot", dryRun: true },
    });
    const result = structured<AdminResult>(res);

    expect(result.dryRun).toBe(true);
    expect(result.command).toBe("reboot");
    expect(result.tier).toBe("destructive");
    // The deterministic tier → annotations triple rides along in the structured
    // output (it can't be the tool's static annotations — admin is multiplexed).
    expect(result.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(result.annotations).toEqual(annotationsForTier(result.tier));
    expect(result.preview).toBeDefined();
    expect(result.preview).toContain("Reboot Rocky");
    // No exec happened: no via, no reply.
    expect(result.via).toBeUndefined();
    expect(result.reply).toBeUndefined();

    await h.cleanup();
  });

  it("admin home exec runs the structured method (set-tx-power)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "set-tx-power", params: { dbm: 20 } },
    });
    const result = structured<AdminResult>(res);

    expect(result.dryRun).toBe(false);
    expect(result.command).toBe("set-tx-power");
    expect(result.tier).toBe("config");
    // A `config`-tier command: not read-only, not destructive, idempotent.
    expect(result.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(result.annotations).toEqual(annotationsForTier(result.tier));
    expect(result.via).toBe("home");
    expect(result.reply).toBeUndefined();

    await h.cleanup();
  });

  it("admin home exec via reboot succeeds against the home node", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "reboot" },
    });
    const result = structured<AdminResult>(res);
    expect(result.via).toBe("home");
    expect(result.dryRun).toBe(false);

    await h.cleanup();
  });

  it("admin remote exec drives login → CliData → scripted reply", async () => {
    // The sim does not auto-reply; script the repeater's CLI reply as a
    // contactMessage from that node a couple seconds out, then advance the
    // clock to deliver it while the admin call is pending (§6, critical sim facts).
    const scn = scenario([
      at("2s", { kind: "message", from: "rocky-ridge", text: "OK - rebooting" }),
    ]);
    const h = await makeSimServer({ world: buildWorld(), scenario: scn });

    const pending = h.client.callTool({
      name: "admin",
      arguments: { node: "Rocky", command: "reboot" },
    });
    // Deliver the scripted reply while the admin promise is pending.
    await h.advance("3s");
    const res = await pending;
    const result = structured<AdminResult>(res);

    expect(result.dryRun).toBe(false);
    expect(result.via).toBe("remote");
    expect(result.command).toBe("reboot");
    // The remote-exec path carries the triple too (reboot → destructive).
    expect(result.annotations).toEqual(annotationsForTier(result.tier));
    expect(result.annotations.destructiveHint).toBe(true);
    expect(result.reply).toBe("OK - rebooting");
    expect(text(res)).toContain("OK - rebooting");

    await h.cleanup();
  });

  it("admin against an unreachable node returns an actionable isError result", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = (await h.client.callTool({
      name: "admin",
      arguments: { node: "Dead", command: "reboot" },
    })) as ToolResult;

    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("Dead");

    await h.cleanup();
  });

  it("a remote-only command against the home node errors clearly", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = (await h.client.callTool({
      name: "admin",
      arguments: { node: "Base", command: "log-start" },
    })) as ToolResult;

    expect(res.isError).toBe(true);
    expect(text(res).toLowerCase()).toContain("remote-only");

    await h.cleanup();
  });

  it("advertises the action-tool annotations (send_message + admin)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const send = byName.get("send_message");
    expect(send).toBeDefined();
    expect(send!.annotations?.readOnlyHint).toBe(false);
    expect(send!.annotations?.idempotentHint).toBe(false);
    expect(send!.annotations?.destructiveHint).toBe(false);
    expect(send!.annotations?.openWorldHint).toBe(true);

    const admin = byName.get("admin");
    expect(admin).toBeDefined();
    expect(admin!.annotations?.readOnlyHint).toBe(false);
    expect(admin!.annotations?.destructiveHint).toBe(true);
    expect(admin!.annotations?.idempotentHint).toBe(false);
    expect(admin!.annotations?.openWorldHint).toBe(true);

    await h.cleanup();
  });
});

describe("ADMIN_COMMANDS registry (unit)", () => {
  it("enumerates all 16 commands with the right tiers", () => {
    const names = Object.keys(ADMIN_COMMANDS).sort();
    expect(names).toHaveLength(16);
    expect(ADMIN_COMMANDS.reboot?.tier).toBe("destructive");
    expect(ADMIN_COMMANDS.advert?.tier).toBe("benign");
    expect(ADMIN_COMMANDS["set-tx-power"]?.tier).toBe("config");
    expect(ADMIN_COMMANDS["set-admin-password"]?.tier).toBe("sensitive");
    expect(ADMIN_COMMANDS["log-erase"]?.tier).toBe("destructive");
  });

  it("scopes remote-only vs home+remote correctly", () => {
    expect(ADMIN_COMMANDS.reboot?.scope).toBe("home+remote");
    expect(ADMIN_COMMANDS["set-radio"]?.scope).toBe("home+remote");
    expect(ADMIN_COMMANDS["set-repeat"]?.scope).toBe("remote-only");
    expect(ADMIN_COMMANDS["set-permission"]?.scope).toBe("remote-only");
    // home+remote commands have a home() path; remote-only do not.
    expect(typeof ADMIN_COMMANDS.reboot?.home).toBe("function");
    expect(ADMIN_COMMANDS["set-repeat"]?.home).toBeUndefined();
  });

  it("validates params via each command's Zod schema", () => {
    const txp = ADMIN_COMMANDS["set-tx-power"]!;
    expect(txp.params.safeParse({ dbm: 20 }).success).toBe(true);
    expect(txp.params.safeParse({ dbm: 99 }).success).toBe(false);
    expect(txp.params.safeParse({}).success).toBe(false);

    const radio = ADMIN_COMMANDS["set-radio"]!;
    expect(radio.params.safeParse({ freqMhz: 910.525, bwKhz: 250, sf: 10, cr: 5 }).success).toBe(
      true,
    );
    expect(radio.params.safeParse({ freqMhz: 910, bwKhz: 250, sf: 99, cr: 5 }).success).toBe(false);

    // No-params commands accept the empty object.
    expect(ADMIN_COMMANDS.reboot!.params.safeParse({}).success).toBe(true);

    // advert defaults mode to flood.
    const advert = ADMIN_COMMANDS.advert!.params.safeParse({});
    expect(advert.success).toBe(true);
    expect((advert as { data: { mode: string } }).data.mode).toBe("flood");
  });

  it("synthesizes previews without contacting a device", () => {
    const preview = ADMIN_COMMANDS["set-tx-power"]!.preview("Rocky", { dbm: 20 } as never);
    expect(preview).toContain("Rocky");
    expect(preview).toContain("20 dBm");
  });

  it("produces the right remote CLI strings", () => {
    expect(ADMIN_COMMANDS.reboot!.remoteCli({} as never)).toBe("reboot");
    expect(ADMIN_COMMANDS["set-tx-power"]!.remoteCli({ dbm: 20 } as never)).toBe("set tx 20");
    expect(ADMIN_COMMANDS["set-location"]!.remoteCli({ lat: 1, lon: 2 } as never)).toEqual([
      "set lat 1",
      "set lon 2",
    ]);
    expect(ADMIN_COMMANDS["set-repeat"]!.remoteCli({ enabled: false } as never)).toBe(
      "set repeat off",
    );
    expect(
      ADMIN_COMMANDS["set-permission"]!.remoteCli({ pubKey: "ABCD", level: "admin" } as never),
    ).toBe("setperm abcd 3");
    expect(
      ADMIN_COMMANDS["set-permission"]!.remoteCli({ pubKey: "ABCD", level: null } as never),
    ).toBe("setperm abcd");
  });

  it("maps risk tiers to annotations deterministically", () => {
    expect(annotationsForTier("read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotationsForTier("benign")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(annotationsForTier("config")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotationsForTier("sensitive")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(annotationsForTier("destructive")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});
