/**
 * Security regression (finding #1): a `secret` remote-admin command
 * (`set-admin-password`) must NOT leak the secret.
 *
 * The repeater echoes the password back in its CLI reply. Two paths could
 * retain it: the always-on `contactMessage` subscription (→ traffic buffer /
 * live stream) and the `admin` tool result (`reply` text + structuredContent).
 * This test drives the full MCP stack against a sim repeater whose responder
 * echoes the password, then asserts the secret appears in neither.
 */
import { TxtType } from "@dpup/meshcore-ts";
import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import type { Responder } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

/** The slice of a `callTool` result these tests assert on. */
interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/** The secret we set — it must never resurface in any consumer-visible output. */
const SECRET = "hunter2pass";

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

/**
 * Echo any CliData command back verbatim, exactly as a real repeater echoes the
 * `password <secret>` line — so the secret rides in the reply text.
 */
const echoResponder: Responder = {
  when: (m) => m.kind === "contact" && m.txtType === TxtType.CliData,
  reply: (m) => (m.to === undefined ? undefined : { from: m.to, text: `> ${m.text}`, after: "1s" }),
};

/**
 * A multi-message reply (§6: "long output may span multiple messages"): the
 * echoed command line lands first (~1s), then a *trailing* confirmation line
 * that re-includes the secret lands after (~1.2s). The second line arrives
 * AFTER `awaitContactReply` already resolved on the first — the regression the
 * drain window guards: without it the prefix is cleared on the first reply, so
 * the trailing line is buffered with its text and the secret re-leaks.
 */
const multiLineEchoResponder: Responder = {
  when: (m) => m.kind === "contact" && m.txtType === TxtType.CliData,
  reply: (m) =>
    m.to === undefined
      ? undefined
      : [
          { from: m.to, text: `> ${m.text}`, after: "1s" },
          { from: m.to, text: `OK: password set to ${m.text.replace(/^password\s+/, "")}`, after: "1.2s" },
        ],
};

describe("security: set-admin-password must not leak the secret", () => {
  it("withholds the echoed secret from the traffic buffer AND the tool result", async () => {
    const h = await makeSimServer({ world: world(), responders: [echoResponder] });

    // The call blocks on the reply; advance the clock to let the responder fire.
    const pending = h.client.callTool({
      name: "admin",
      arguments: {
        node: "Rocky",
        command: "set-admin-password",
        params: { password: SECRET },
      },
    });
    await h.advance("3s");
    const res = (await pending) as ToolResult;

    expect(res.isError).toBeFalsy();

    // (a) NO buffered/recent-traffic event retains the secret in its `text`.
    const traffic = (await h.client.callTool({ name: "get_recent_traffic", arguments: {} })) as ToolResult;
    const events = (traffic.structuredContent as { events?: Array<{ text?: string }> }).events ?? [];
    expect(events.length).toBeGreaterThan(0); // the redacted contact event is still recorded
    for (const e of events) {
      expect(e.text ?? "").not.toContain(SECRET);
    }
    // And the contact reply event survives with its text dropped (provenance kept).
    const replyEvent = events.find((e) => (e as { kind?: string }).kind === "contact" && e.text === undefined);
    expect(replyEvent).toBeDefined();

    // (b) The admin tool result text AND structuredContent.reply withhold the secret.
    const out = res.structuredContent as { reply?: string; tier?: string; via?: string };
    expect(out.via).toBe("remote");
    expect(out.tier).toBe("sensitive");
    expect(out.reply ?? "").not.toContain(SECRET);
    expect(out.reply).toBe("(reply withheld — contains a secret)");

    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("reply withheld");

    await h.cleanup();
  });

  it("redacts a TRAILING echo line that arrives after the first reply (multi-message §6)", async () => {
    const h = await makeSimServer({ world: world(), responders: [multiLineEchoResponder] });

    const pending = h.client.callTool({
      name: "admin",
      arguments: {
        node: "Rocky",
        command: "set-admin-password",
        params: { password: SECRET },
      },
    });
    // Advance past BOTH replies: the echo at ~1s and the trailing confirmation
    // (which re-includes the secret) at ~1.2s. Without the drain window the
    // prefix is cleared once the first reply resolves, so this second line is
    // buffered WITH its text and the secret re-leaks.
    await h.advance("3s");
    const res = (await pending) as ToolResult;

    expect(res.isError).toBeFalsy();

    // No buffered/recent-traffic event retains the secret — neither the first
    // echo nor the trailing confirmation line.
    const traffic = (await h.client.callTool({ name: "get_recent_traffic", arguments: {} })) as ToolResult;
    const events = (traffic.structuredContent as { events?: Array<{ text?: string }> }).events ?? [];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.text ?? "").not.toContain(SECRET);
    }

    // The result reply is still the fixed withheld notice.
    const out = res.structuredContent as { reply?: string; via?: string; tier?: string };
    expect(out.via).toBe("remote");
    expect(out.tier).toBe("sensitive");
    expect(out.reply).toBe("(reply withheld — contains a secret)");

    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    expect(text).not.toContain(SECRET);

    await h.cleanup();
  });
});
