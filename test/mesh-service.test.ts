import { MeshCoreClient } from "@dpup/meshcore-ts";
import {
  SimClock,
  SimConnection,
  at,
  channel,
  contact,
  defineWorld,
  node,
  scenario,
  traffic,
} from "@dpup/meshcore-sim";
import { describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore, MeshService } from "../src/index.js";
import type { Clock, Duration, TimerHandle } from "../src/index.js";

/**
 * The M1 proof: drive a real `MeshCoreClient` over a sim-backed connection and a
 * `SimClock`, hand `MeshService` *that same clock*, advance virtual time, and
 * assert the buffered traffic carries the right provenance stamped with
 * virtual-clock `at` times. No MCP layer, no hardware — the §1 seam minus MCP.
 */

/**
 * Flush the microtask queue enough times for the client's drain chain to fully
 * settle. The `MsgWaiting → getWaitingMessages() → emit` drain is async and
 * re-entrant (it re-drains via `pendingDrain`), so it spans many microtask
 * turns; a generous, bounded loop of `await`s drains it deterministically
 * without touching real time.
 */
async function flush(times = 64): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Advance the virtual clock by `by` and let the resulting drain settle. Because
 * the client drains on microtasks *after* `advance()` returns — when
 * `clock.now()` already equals the step's end — stepping in fine increments is
 * what lets each event be observed (and stamped) at its own virtual time rather
 * than collapsed onto a single far-future instant.
 */
async function tick(clock: SimClock, by: string): Promise<void> {
  clock.advance(by);
  await flush();
}

/** Build the small shared world (home + a repeater contact, a public + admin channel). */
function buildWorld() {
  return defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base" }),
      node("rocky", { name: "Rocky", role: "repeater" }),
    ],
    channels: [channel(0, "public"), channel(7, "admin", { kind: "private" })],
    contacts: [contact("Rocky", "rocky")],
  });
}

describe("Clock / SimClock structural compatibility", () => {
  it("a SimClock is assignable to the production Clock interface", () => {
    // The type-level contract M1 hangs on: tests inject SimClock where
    // production injects SystemClock. If this stops compiling the seam is broken.
    const _c: Clock = new SimClock();
    expect(_c.now()).toBe(0);
  });
});

describe("MeshService over a sim-backed MeshCoreClient", () => {
  it("buffers a contact-message burst with verified provenance and virtual-clock stamps", async () => {
    const world = buildWorld();
    const clock = new SimClock();
    const scn = traffic.burst({ from: "rocky", count: 3, within: "10s", seed: 42 });
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });

    const service = new MeshService(client, clock, { credentialStore: new InMemoryCredentialStore() });
    await service.start();

    // Drive the scenario one virtual second at a time, so each burst message is
    // observed (and stamped) near its own fire time rather than collapsed onto
    // the window's end.
    for (let s = 0; s < 10; s++) {
      await tick(clock, "1s");
    }

    const events = service.recentTraffic();
    const contacts = events.filter((e) => e.kind === "contact");
    expect(contacts).toHaveLength(3);

    for (const e of contacts) {
      expect(e.kind).toBe("contact");
      expect(e.decryptVerified).toBe(true);
      expect(typeof e.sender).toBe("string");
      expect(e.sender).toBeTruthy();
      expect(typeof e.text).toBe("string");
      expect(e.id).toMatch(/^evt-\d+$/);
      // Stamped with virtual-clock time inside the 10s window.
      expect(e.at).toBeGreaterThanOrEqual(0);
      expect(e.at).toBeLessThanOrEqual(10_000);
    }

    // Oldest→newest ordering.
    const ats = contacts.map((e) => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);

    await service.stop();
  });

  it("distinguishes a verified channel message from an unverified channel datagram", async () => {
    const world = buildWorld();
    const clock = new SimClock();
    const scn = scenario([
      at("2s", {
        kind: "channelMessage",
        channel: 0,
        text: "status: all green",
        verified: true,
      }),
      // The admin-gate negative case: an unverified datagram on the admin idx.
      at("3s", {
        kind: "channelMessage",
        channel: 7,
        text: "secret bytes",
        verified: false,
        snr: 7,
      }),
    ]);
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });

    const service = new MeshService(client, clock, { credentialStore: new InMemoryCredentialStore() });
    await service.start();

    // Step to each event's fire time so the `at` stamps reflect virtual time.
    await tick(clock, "2s"); // verified channel message fires
    await tick(clock, "1s"); // unverified admin-channel datagram fires
    await tick(clock, "2s");

    const events = service.recentTraffic();

    const verified = events.find((e) => e.kind === "channel");
    expect(verified).toBeDefined();
    expect(verified?.decryptVerified).toBe(true);
    expect(verified?.channelIdx).toBe(0);
    expect(verified?.text).toBe("status: all green");
    expect(verified?.at).toBe(2_000);

    const unverified = events.find((e) => e.kind === "channelData");
    expect(unverified).toBeDefined();
    expect(unverified?.decryptVerified).toBe(false);
    expect(unverified?.channelIdx).toBe(7);
    // Unverified traffic never carries decoded text.
    expect(unverified?.text).toBeUndefined();
    expect(unverified?.snr).toBe(7);
    expect(unverified?.at).toBe(3_000);

    // The negative case never surfaces as a verified channel message.
    const verifiedOnAdmin = events.find(
      (e) => e.kind === "channel" && e.channelIdx === 7,
    );
    expect(verifiedOnAdmin).toBeUndefined();

    await service.stop();
  });

  it("recentTraffic(since) windows by the injected clock", async () => {
    const world = buildWorld();
    const clock = new SimClock();
    const scn = scenario([
      at("1s", { kind: "message", from: "rocky", text: "early" }),
      at("8s", { kind: "message", from: "rocky", text: "late" }),
    ]);
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });

    const service = new MeshService(client, clock, { credentialStore: new InMemoryCredentialStore() });
    await service.start();

    // Step past each message so each is stamped at its own virtual time
    // (early at ~1s, late at ~8s), letting the `since` window discriminate.
    for (let s = 0; s < 10; s++) {
      await tick(clock, "1s");
    }

    expect(service.recentTraffic().map((e) => e.text)).toEqual(["early", "late"]);
    // Only the event stamped at/after 5s.
    expect(service.recentTraffic(5_000).map((e) => e.text)).toEqual(["late"]);

    await service.stop();
  });
});

describe("sendMessage confirm: ack-wait window honours a reported estTimeout of 0", () => {
  /** A Clock that delegates to a SimClock but records every setTimeout delay (ms). */
  class RecordingClock implements Clock {
    readonly delays: number[] = [];
    constructor(private readonly inner: SimClock) {}
    now(): number {
      return this.inner.now();
    }
    setTimeout(callback: () => void, delay: Duration): TimerHandle {
      this.delays.push(typeof delay === "number" ? delay : Number.NaN);
      return this.inner.setTimeout(callback, delay);
    }
    clearTimeout(handle: TimerHandle): void {
      this.inner.clearTimeout(handle);
    }
  }

  it("uses a 2000ms window (0 + 2000) when the device reports estTimeout: 0, not the 4000 fallback", async () => {
    const world = buildWorld();
    const sim = new SimClock();
    const clock = new RecordingClock(sim);
    const conn = new SimConnection({ world, clock: sim });
    const client = new MeshCoreClient(conn.asConnection(), { autoSync: true });

    const service = new MeshService(client, clock, { credentialStore: new InMemoryCredentialStore() });
    await service.start();

    // The `??` fix: a legit reported estTimeout of 0 must survive (0 + 2000 =
    // 2000ms window). With the old `|| 4000` it would have been re-inflated to
    // 4000 → a 6000ms window. No ack ever arrives, so the timer fires and the
    // send resolves `delivered: false`.
    vi.spyOn(client, "sendTextMessage").mockResolvedValue({
      result: 0,
      expectedAckCrc: 0xabcd,
      estTimeout: 0,
    });

    const sendP = service.sendMessage("Rocky", "ping", { confirm: true });
    await flush();
    sim.advance("2s"); // fire the scheduled timer
    const result = await sendP;

    expect(result.delivered).toBe(false);
    expect(clock.delays).toContain(2000);
    expect(clock.delays).not.toContain(6000);

    await service.stop();
  });
});
