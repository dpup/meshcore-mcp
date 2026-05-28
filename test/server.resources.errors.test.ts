/**
 * H2 — resource reads catch device errors and surface an actionable McpError,
 * not the SDK's opaque `-32603 Request timed out waiting for a device response`.
 * Combined with H1's retry, transient failures usually never reach this path; a
 * persistent failure now arrives as a clean, prefixed message.
 */
import { MeshCoreTimeoutError } from "@dpup/meshcore-ts";
import { channel, defineWorld, node } from "@dpup/meshcore-sim";
import { describe, expect, it, vi } from "vitest";

import { makeSimServer } from "./helpers/sim-server.js";

function world() {
  return defineWorld({
    homeNodeId: "base",
    nodes: [node("base", { name: "Base" })],
    channels: [channel(0, "public")],
    contacts: [],
  });
}

describe("resources surface actionable errors (H2)", () => {
  it("meshcore://channels — persistent device timeout becomes an actionable McpError", async () => {
    const h = await makeSimServer({ world: world() });
    vi.spyOn(h.meshClient, "getChannels").mockRejectedValue(new MeshCoreTimeoutError());

    const pending = h.client
      .readResource({ uri: "meshcore://channels" })
      .catch((err: Error) => err);
    await h.advance("3s"); // through the retry backoffs
    const err = (await pending) as Error;

    expect(err.message).toContain("meshcore://channels");
    expect(err.message).toMatch(/unreachable|timed out/i);
    // The point of the fix: no raw "Request timed out waiting for a device
    // response" — the actionable message has prefix + context.
    expect(err.message).toContain("reading channels");

    await h.cleanup();
  });

  it("meshcore://nodes — surfaces the same shape", async () => {
    const h = await makeSimServer({ world: world() });
    vi.spyOn(h.meshClient, "getContacts").mockRejectedValue(new MeshCoreTimeoutError());

    const pending = h.client
      .readResource({ uri: "meshcore://nodes" })
      .catch((err: Error) => err);
    await h.advance("3s");
    const err = (await pending) as Error;

    expect(err.message).toContain("meshcore://nodes");
    expect(err.message).toContain("reading mesh roster");
    await h.cleanup();
  });
});
