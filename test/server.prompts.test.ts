import { channel, contact, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

/**
 * The M5 done-when proof: drive the **curated prompt templates** through a real
 * MCP `Client` over the sim-backed harness, and assert on the **prompt results**
 * — the listing and the rendered messages — never on server internals (AGENTS.md,
 * execution plan §5).
 *
 * A prompt *frames* (PRD §5.4): each rendered message must name the real tools it
 * points at and carry the interpolated argument values, but it is content, not
 * control flow, so we assert references and substitution rather than an exact
 * script.
 */

/** A world with a home node and two contacts (one a repeater). */
function buildWorld() {
  return defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base", battery: 80 }),
      node("rocky-ridge", { name: "Rocky", role: "repeater", battery: 42 }),
      node("ferndale", { name: "Fern" }),
    ],
    channels: [channel(0, "public")],
    contacts: [contact("Rocky", "rocky-ridge"), contact("Fern", "ferndale")],
  });
}

/** Pull the single rendered `user` text out of a `getPrompt` result. */
function renderedText(res: { messages: Array<{ role: string; content: { type: string; text?: string } }> }): string {
  expect(res.messages).toHaveLength(1);
  const first = res.messages[0];
  expect(first).toBeDefined();
  expect(first?.role).toBe("user");
  expect(first?.content.type).toBe("text");
  expect(typeof first?.content.text).toBe("string");
  return first!.content.text!;
}

describe("server prompts (M5)", () => {
  it("lists exactly the three curated prompts, with args declared for the parameterized ones", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    try {
      const { prompts } = await h.client.listPrompts();
      const byName = new Map(prompts.map((p) => [p.name, p]));

      expect(new Set(byName.keys())).toEqual(
        new Set(["morning-mesh-check", "diagnose-quiet-node", "draft-outage-notice"]),
      );

      // Every prompt carries a description.
      for (const p of prompts) {
        expect(typeof p.description).toBe("string");
        expect(p.description!.length).toBeGreaterThan(0);
      }

      // morning-mesh-check takes no args.
      expect(byName.get("morning-mesh-check")?.arguments ?? []).toEqual([]);

      // diagnose-quiet-node declares a required `node` arg.
      const diagnose = byName.get("diagnose-quiet-node");
      const diagnoseArg = diagnose?.arguments?.find((a) => a.name === "node");
      expect(diagnoseArg).toBeDefined();
      expect(diagnoseArg?.required).toBe(true);

      // draft-outage-notice declares a required `node` and an optional `window`.
      const draft = byName.get("draft-outage-notice");
      const draftNode = draft?.arguments?.find((a) => a.name === "node");
      const draftWindow = draft?.arguments?.find((a) => a.name === "window");
      expect(draftNode?.required).toBe(true);
      expect(draftWindow).toBeDefined();
      expect(draftWindow?.required ?? false).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("renders morning-mesh-check pointing at the survey/traffic/health tools", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    try {
      const res = await h.client.getPrompt({ name: "morning-mesh-check" });
      const text = renderedText(res);
      expect(text).toContain("survey_mesh");
      expect(text).toContain("get_recent_traffic");
      expect(text).toContain("get_node_health");
    } finally {
      await h.cleanup();
    }
  });

  it("renders diagnose-quiet-node with the interpolated node and the right tools", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    try {
      const res = await h.client.getPrompt({
        name: "diagnose-quiet-node",
        arguments: { node: "rocky-ridge" },
      });
      const text = renderedText(res);
      expect(text).toContain("rocky-ridge");
      expect(text).toContain("get_node_health");
      expect(text).toContain("get_recent_traffic");
      expect(text).toContain("survey_mesh");
    } finally {
      await h.cleanup();
    }
  });

  it("renders draft-outage-notice with the interpolated node + window and the right tools", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    try {
      const res = await h.client.getPrompt({
        name: "draft-outage-notice",
        arguments: { node: "Rocky", window: "08:00–09:30 today" },
      });
      const text = renderedText(res);
      expect(text).toContain("Rocky");
      expect(text).toContain("08:00–09:30 today");
      expect(text).toContain("get_node_health");
      expect(text).toContain("send_message");
    } finally {
      await h.cleanup();
    }
  });

  it("defaults the window text when draft-outage-notice omits it", async () => {
    const h = await makeSimServer({ world: buildWorld() });
    try {
      const res = await h.client.getPrompt({
        name: "draft-outage-notice",
        arguments: { node: "Rocky" },
      });
      const text = renderedText(res);
      expect(text).toContain("Rocky");
      // A sensible default fills in for the missing window.
      expect(text).toContain("the recent outage window");
      expect(text).toContain("get_node_health");
      expect(text).toContain("send_message");
    } finally {
      await h.cleanup();
    }
  });
});
