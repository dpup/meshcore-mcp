/**
 * Friendly output/input batch (H9/H10/H11): human-readable last-heard under
 * clock skew, relative traffic times + relative `since`, recent-first roster.
 */
import { channel, contact, defineWorld, node, scenario, traffic } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { formatRelative } from "../src/index.js";
import { resolveSince } from "../src/tools/get-recent-traffic.js";
import { makeSimServer } from "./helpers/sim-server.js";

describe("formatRelative (H9 — clock skew)", () => {
  it("treats a small forward skew (negative elapsed) as 'just now', not 'unknown'", () => {
    expect(formatRelative(-30_000)).toBe("just now"); // node RTC 30s ahead
    expect(formatRelative(-3_600_000)).toBe("just now"); // 1h ahead
  });
  it("flags bogus values as 'unknown'", () => {
    expect(formatRelative(Number.NaN)).toBe("unknown");
    expect(formatRelative(-10 * 86_400_000)).toBe("unknown"); // 10 days ahead = bogus
    expect(formatRelative(Date.now())).toBe("unknown"); // ~epoch-0 lastAdvert ⇒ decades
  });
  it("renders normal elapseds", () => {
    expect(formatRelative(5_000)).toBe("just now");
    expect(formatRelative(120_000)).toBe("2m ago");
    expect(formatRelative(7_200_000)).toBe("2h ago");
    expect(formatRelative(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("resolveSince (H10 — relative window)", () => {
  const now = 1_000_000;
  it("accepts a relative duration as 'within the last X'", () => {
    expect(resolveSince("10m", now)).toBe(now - 600_000);
    expect(resolveSince("1h", now)).toBe(now - 3_600_000);
    expect(resolveSince("30s", now)).toBe(now - 30_000);
  });
  it("still accepts epoch-ms and ISO-8601", () => {
    expect(resolveSince(5000, now)).toBe(5000);
    expect(resolveSince("1970-01-01T00:00:05.000Z", now)).toBe(5000);
  });
  it("throws on garbage", () => {
    expect(() => resolveSince("soonish", now)).toThrow(/invalid `since`/);
  });
});

describe("get_recent_traffic digest (H10 — human times)", () => {
  it("renders relative times, not raw ms", async () => {
    const burst = traffic.burst({ from: "rocky", count: 2, within: "6s", seed: 1 });
    const world = defineWorld({
      homeNodeId: "base",
      nodes: [node("base", { name: "Base" }), node("rocky", { name: "Rocky", role: "repeater" })],
      channels: [channel(0, "public")],
      contacts: [contact("Rocky", "rocky")],
    });
    const h = await makeSimServer({ world, scenario: scenario([...burst.events]) });
    await h.advance("8s");
    const res = (await h.client.callTool({ name: "get_recent_traffic", arguments: {} })) as {
      content?: { text?: string }[];
    };
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/just now|ago/);
    expect(text).not.toMatch(/\d+ms \[/); // no raw "4500ms [contact/…]"
    await h.cleanup();
  });
});
