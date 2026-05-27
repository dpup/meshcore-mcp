import {
  at,
  channel,
  contact,
  defineWorld,
  node,
  scenario,
  traffic,
} from "@dpup/meshcore-sim";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";
import {
  CONTACTS_URI,
  NODES_URI,
  TRAFFIC_LIVE_URI,
  type MeshSurvey,
  type TrafficEvent,
} from "../src/index.js";

/**
 * The M4 done-when proof: drive the **three resources** through a real MCP
 * `Client` over the sim-backed harness, and assert on the **resource results
 * and the live notifications** — never on server internals (AGENTS.md,
 * execution plan §5). This is the milestone the structural-provenance
 * requirement exists for.
 */

/** A world with a home node, two contacts (one a repeater), and an admin channel. */
function buildWorld() {
  return defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base", battery: 80 }),
      node("rocky-ridge", { name: "Rocky", role: "repeater", battery: 42 }),
      node("ferndale", { name: "Fern" }),
    ],
    channels: [channel(0, "public"), channel(7, "admin", { kind: "private" })],
    contacts: [contact("Rocky", "rocky-ridge"), contact("Fern", "ferndale")],
  });
}

/** The JSON payload carried in a resource read's single `contents` entry. */
function readJson<T>(res: { contents: Array<{ uri: string; text?: string }> }): T {
  const first = res.contents[0];
  expect(first).toBeDefined();
  expect(typeof first?.text).toBe("string");
  return JSON.parse(first!.text!) as T;
}

describe("resources through a real MCP Client over a sim-backed server", () => {
  it("live subscription delivers one ordered update per burst event, then reads them back", async () => {
    const scn = traffic.burst({ from: "rocky-ridge", count: 3, within: "10s", seed: 11 });
    const h = await makeSimServer({ world: buildWorld(), scenario: scn });

    // Collect update notifications in arrival order before subscribing.
    const updates: string[] = [];
    h.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });

    await h.client.subscribeResource({ uri: TRAFFIC_LIVE_URI });

    // Advance through the burst; the harness settles autoSync's microtask drain
    // in fine steps so each event is observed (and pushed) near its fire time.
    await h.advance("12s");
    // Settle the notification round-trip back to the client.
    await h.flush();

    // One notification per delivered event, all for the live uri, in order.
    expect(updates).toHaveLength(3);
    expect(updates.every((u) => u === TRAFFIC_LIVE_URI)).toBe(true);

    // Re-read the resource: the burst's events are present, oldest→newest.
    const { events, count } = readJson<{ events: TrafficEvent[]; count: number }>(
      await h.client.readResource({ uri: TRAFFIC_LIVE_URI }),
    );
    const contactEvents = events.filter((e) => e.kind === "contact");
    expect(contactEvents).toHaveLength(3);
    expect(count).toBe(events.length);
    // Ordered by observation time (oldest→newest).
    const ats = contactEvents.map((e) => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);

    await h.cleanup();
  });

  it("marks a verified channel message and an unverified admin datagram differently", async () => {
    // BOTH cases on the timeline: a decrypt-verified channel message (surfaces
    // as `channelMessage` → kind "channel", decryptVerified true) and an
    // unverified admin-channel datagram (surfaces as `channelData` → kind
    // "channelData", decryptVerified false, no decoded text).
    const scn = scenario([
      at("2s", { kind: "channelMessage", channel: 0, text: "all green", verified: true }),
      at("3s", {
        kind: "channelMessage",
        channel: 7,
        text: "reboot now",
        verified: false,
        snr: 7,
      }),
    ]);
    const h = await makeSimServer({ world: buildWorld(), scenario: scn });

    await h.advance("5s");

    const { events } = readJson<{ events: TrafficEvent[] }>(
      await h.client.readResource({ uri: TRAFFIC_LIVE_URI }),
    );

    // The verified channel message: kind "channel", verified, decoded text.
    const verified = events.find((e) => e.kind === "channel");
    expect(verified).toBeDefined();
    expect(verified?.decryptVerified).toBe(true);
    expect(verified?.channelIdx).toBe(0);
    expect(verified?.text).toBe("all green");

    // The unverified admin datagram: kind "channelData", unverified, NO text.
    const unverified = events.find((e) => e.kind === "channelData");
    expect(unverified).toBeDefined();
    expect(unverified?.decryptVerified).toBe(false);
    expect(unverified?.channelIdx).toBe(7);
    expect(unverified?.text).toBeUndefined();

    // The negative case never appears as a verified `channel` event: no
    // verified channel event carries channel 7, and the only `channel` event is
    // the public, verified one.
    const channelEvents = events.filter((e) => e.kind === "channel");
    expect(channelEvents).toHaveLength(1);
    expect(channelEvents.every((e) => e.decryptVerified === true)).toBe(true);
    expect(channelEvents.some((e) => e.channelIdx === 7)).toBe(false);
    // No verified event carries the admin-channel text.
    expect(events.some((e) => e.decryptVerified && e.text === "reboot now")).toBe(false);

    await h.cleanup();
  });

  it("reads the roster (meshcore://nodes) and the contact list (meshcore://contacts)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const survey = readJson<MeshSurvey>(await h.client.readResource({ uri: NODES_URI }));
    expect(survey.home.name).toBe("Base");
    expect(survey.home.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const rosterNames = survey.contacts.map((c) => c.name).sort();
    expect(rosterNames).toEqual(["Fern", "Rocky"]);
    for (const c of survey.contacts) {
      expect(c.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof c.lastHeardMs).toBe("number");
    }

    const { contacts, count } = readJson<{
      contacts: Array<{ advName: string; publicKey: string; lastAdvert: string }>;
      count: number;
    }>(await h.client.readResource({ uri: CONTACTS_URI }));
    expect(count).toBe(contacts.length);
    const contactNames = contacts.map((c) => c.advName).sort();
    expect(contactNames).toEqual(["Fern", "Rocky"]);
    for (const c of contacts) {
      expect(c.publicKey).toMatch(/^[0-9a-f]{64}$/);
      // Date fields serialize to ISO strings through JSON.
      expect(typeof c.lastAdvert).toBe("string");
    }

    await h.cleanup();
  });
});
