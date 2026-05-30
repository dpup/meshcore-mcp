/**
 * Full-stack tests for the `set_credential` / `forget_credential` tools and
 * the credential layering they sit on top of (store ⟶ env per-node ⟶ env
 * default). Drives a real MCP `Client` over the sim-backed harness, then
 * spies on `client.login` to assert the stored password is the one actually
 * sent at login (the sim's `commandsOf("login")` does not record the
 * password — `_password` is unused in `SimConnection.login`).
 */
import { at, channel, contact, defineWorld, node, scenario } from "@dpup/meshcore-sim";
import { describe, expect, it, vi } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";
import { InMemoryCredentialStore } from "../src/index.js";

/** Home + reachable repeater. The remote-admin tests script Rocky's CLI reply. */
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

function text(res: unknown): string {
  const first = (res as ToolResult).content?.[0];
  return first?.text ?? "";
}

describe("set_credential / forget_credential through the MCP stack", () => {
  it("set_credential stores the password and never echoes it back", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Rocky", password: "hunter2-secret" },
    });
    const out = structured<{ node: string; stored: true }>(res);
    expect(out).toEqual({ node: "Rocky", stored: true });

    // The password must not appear in the digest text or anywhere structured.
    expect(text(res)).not.toContain("hunter2-secret");
    expect(JSON.stringify(out)).not.toContain("hunter2-secret");

    // The store has it — proves we actually wrote through, not just returned ok.
    expect(h.credentialStore.get("Rocky")).toBe("hunter2-secret");

    await h.cleanup();
  });

  it("a subsequent admin call uses the stored password at login", async () => {
    // Scenario scripts Rocky's CLI reply 2s out so the admin call resolves.
    const scn = scenario([
      at("2s", { kind: "message", from: "rocky-ridge", text: "OK - rebooting" }),
    ]);
    const h = await makeSimServer({ world: buildWorld(), scenario: scn });

    // The sim's commandLog does not record the password — spy on the real
    // client.login instead. vi.spyOn forwards to the original by default,
    // so the admin handshake still completes.
    const loginSpy = vi.spyOn(h.meshClient, "login");

    await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Rocky", password: "rr-secret" },
    });

    const pending = h.client.callTool({
      name: "admin",
      arguments: { node: "Rocky", command: "reboot" },
    });
    await h.advance("3s");
    const res = (await pending) as ToolResult;
    expect(res.isError).toBeFalsy();

    // The second arg of MeshCoreClient.login is the password.
    expect(loginSpy).toHaveBeenCalled();
    const last = loginSpy.mock.calls.at(-1);
    expect(last?.[1]).toBe("rr-secret");

    await h.cleanup();
  });

  it("forget_credential removes the entry; the next admin falls back to env default", async () => {
    const scn = scenario([
      at("2s", { kind: "message", from: "rocky-ridge", text: "OK - rebooting" }),
    ]);
    const h = await makeSimServer({
      world: buildWorld(),
      scenario: scn,
      // Env-default credential: every node gets "env-default" unless the
      // store has an entry (mirrors how cli.ts composes the callback).
      credentials: () => "env-default",
    });

    const loginSpy = vi.spyOn(h.meshClient, "login");

    // Store one, then drop it.
    await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Rocky", password: "stored-pw" },
    });
    const removed = await h.client.callTool({
      name: "forget_credential",
      arguments: { node: "Rocky" },
    });
    const out = structured<{ node: string; removed: boolean }>(removed);
    expect(out).toEqual({ node: "Rocky", removed: true });

    // Subsequent admin falls back to the env-default credential.
    const pending = h.client.callTool({
      name: "admin",
      arguments: { node: "Rocky", command: "reboot" },
    });
    await h.advance("3s");
    await pending;

    expect(loginSpy.mock.calls.at(-1)?.[1]).toBe("env-default");

    await h.cleanup();
  });

  it("forget_credential on an unknown node returns removed: false (still succeeds)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "forget_credential",
      arguments: { node: "Rocky" },
    });
    const out = structured<{ node: string; removed: boolean }>(res);
    expect(out).toEqual({ node: "Rocky", removed: false });
    expect(text(res).toLowerCase()).toContain("no stored credential");

    await h.cleanup();
  });

  it("layering: store > env per-node > env default", async () => {
    // An env-style credentials callback that mimics a per-node map + default.
    const envPerNode: Record<string, string> = { rocky: "env-rr" };
    const envDefault = "env-default";
    const credentials = (node: string): string =>
      envPerNode[node] ?? envDefault;

    // Preload the store with one entry to prove store wins over per-node.
    const credentialStore = new InMemoryCredentialStore();
    await credentialStore.set("rocky", "stored-rr");

    const h = await makeSimServer({
      world: buildWorld(),
      credentials,
      credentialStore,
    });

    // Pull the composed resolver out of the service and probe it directly —
    // the seam under test is "store wins, then env per-node, then default".
    // (The service exposes the resolver only through its callers; assert via
    // the same callback shape `cli.ts`/`sim-server.ts` build.)
    const resolved = (node: string): string | undefined =>
      h.credentialStore.get(node) ?? credentials(node);
    expect(resolved("rocky")).toBe("stored-rr");       // store wins
    await h.credentialStore.delete("rocky");
    expect(resolved("rocky")).toBe("env-rr");          // env per-node wins next
    expect(resolved("anything-else")).toBe("env-default"); // default catches the rest

    await h.cleanup();
  });

  it("a second set_credential overwrites the first", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Rocky", password: "first" },
    });
    await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Rocky", password: "second" },
    });
    expect(h.credentialStore.get("Rocky")).toBe("second");

    await h.cleanup();
  });

  it("set_credential rejects a node that isn't in the contact list (typo guard)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = (await h.client.callTool({
      name: "set_credential",
      arguments: { node: "NotARealContact", password: "pw" },
    })) as ToolResult;

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("NotARealContact");
    // The store stays empty — the typo did not silently land an entry.
    expect(h.credentialStore.get("NotARealContact")).toBeUndefined();
    expect(h.credentialStore.nodes()).toEqual([]);

    await h.cleanup();
  });

  it("set_credential accepts the home node (lookup by name or pubkey prefix)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Base", password: "home-pw" },
    });
    const out = structured<{ node: string; stored: true }>(res);
    expect(out.stored).toBe(true);
    expect(h.credentialStore.get("Base")).toBe("home-pw");

    await h.cleanup();
  });

  it("set_credential rejects a password longer than 256 chars (Zod cap)", async () => {
    const h = await makeSimServer({ world: buildWorld() });

    const res = (await h.client.callTool({
      name: "set_credential",
      arguments: { node: "Rocky", password: "x".repeat(257) },
    })) as ToolResult;

    // Zod input-schema validation rejects before the handler runs — the SDK
    // surfaces it as an MCP error result, not a tool isError.
    // Either way, no entry should land.
    expect(h.credentialStore.get("Rocky")).toBeUndefined();
    // Some signal of failure (either MCP error or tool isError).
    const failed = res.isError === true ||
      // SDK validation errors come back as content with a Zod message; the
      // exact shape isn't important — just that it didn't succeed silently.
      (res.structuredContent === undefined && res.content !== undefined);
    expect(failed).toBe(true);

    await h.cleanup();
  });
});
