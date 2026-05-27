import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

describe("server smoke", () => {
  it("completes the MCP initialize handshake over an in-memory transport", async () => {
    const server = createServer();
    const client = new Client({ name: "smoke-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // The handshake completed: the client now knows who it's talking to.
    expect(client.getServerVersion()?.name).toBe("meshcore-mcp");

    await client.close();
    await server.close();
  });
});
