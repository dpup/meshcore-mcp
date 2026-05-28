/**
 * Friendly output/input batch (H9/H10/H11): human-readable last-heard under
 * clock skew, relative traffic times + relative `since`, recent-first roster.
 */
import { channel, contact, defineWorld, node, scenario, traffic } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { AdvType, MeshCoreTimeoutError } from "@dpup/meshcore-ts";

import { formatRelative, toolError } from "../src/index.js";
import { digestMeshSurvey } from "../src/format.js";
import type { MeshSurvey } from "../src/index.js";
import { resolveSince } from "../src/tools/get-recent-traffic.js";
import { makeSimServer } from "./helpers/sim-server.js";

describe("toolError (H12 — friendly timeout hint)", () => {
  it("adds a plain-language hint to a timeout", () => {
    const r = toolError(new MeshCoreTimeoutError(), { node: "Rocky", attempted: "reading node health" });
    const text = r.content[0]?.text ?? "";
    expect(text).toMatch(/offline or out of range/);
    expect(text).toContain("Rocky");
  });
});

describe("survey_mesh summary line (H13)", () => {
  it("leads with a graspable overview (counts + roles)", async () => {
    const world = defineWorld({
      homeNodeId: "base",
      nodes: [
        node("base", { name: "Base" }),
        node("rocky", { name: "Rocky", role: "repeater" }),
        node("cedar", { name: "Cedar", role: "repeater" }),
        node("hq", { name: "HQ", role: "roomserver" }),
      ],
      channels: [channel(0, "public")],
      contacts: [contact("Rocky", "rocky"), contact("Cedar", "cedar"), contact("HQ", "hq")],
    });
    const h = await makeSimServer({ world });
    const res = (await h.client.callTool({ name: "survey_mesh", arguments: {} })) as {
      content?: { text?: string }[];
    };
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/3 contact\(s\) —/); // summary header, not a bare "3 contact(s):"
    expect(text).toContain("repeaters");
    await h.cleanup();
  });

  it("does NOT count a forward-skewed (future) contact as 'heard in the last hour'", () => {
    const nowMs = 10_000_000_000;
    const survey: MeshSurvey = {
      home: { name: "Base", publicKey: "aa".repeat(32), role: AdvType.Chat },
      contacts: [
        // ~12h in the future: a badly-skewed RTC. Outside the symmetric ~1h
        // recent window, so it must NOT inflate the "heard in the last hour"
        // count — but per-row it still reads "just now" (formatRelative's
        // separate 2-day forward-skew tolerance is unchanged).
        { name: "Skewy", publicKey: "bb".repeat(32), role: AdvType.Chat, lastHeardMs: nowMs + 12 * 3_600_000 },
      ],
    };
    const text = digestMeshSurvey(survey, nowMs);
    expect(text).toContain("0 heard in the last hour");
    expect(text).toMatch(/Skewy .* — last heard just now/);
  });

  it("counts a contact heard within the last hour", () => {
    const nowMs = 10_000_000_000;
    const survey: MeshSurvey = {
      home: { name: "Base", publicKey: "aa".repeat(32), role: AdvType.Chat },
      contacts: [
        { name: "Fresh", publicKey: "cc".repeat(32), role: AdvType.Chat, lastHeardMs: nowMs - 10 * 60_000 },
      ],
    };
    expect(digestMeshSurvey(survey, nowMs)).toContain("1 heard in the last hour");
  });
});

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

describe("battery percent (H14)", () => {
  it("reports an approximate charge % for the home node and shows it in the digest", async () => {
    // Sim battery is a %, mapped to 3000..4200mV: 80% ⇒ 3960mV.
    const world = defineWorld({
      homeNodeId: "base",
      nodes: [node("base", { name: "Base", battery: 80 })],
      channels: [channel(0, "public")],
      contacts: [],
    });
    const h = await makeSimServer({ world });
    const res = (await h.client.callTool({ name: "get_node_health", arguments: {} })) as {
      structuredContent?: { battery?: { milliVolts: number; percent?: number } };
      content?: { text?: string }[];
    };
    const bat = res.structuredContent?.battery;
    expect(bat?.milliVolts).toBe(3960);
    // (3960-3300)/900*100 = 73%
    expect(bat?.percent).toBe(73);
    expect(res.content?.[0]?.text ?? "").toMatch(/battery [\d.]+V \(~73%\)/);
    await h.cleanup();
  });
});
