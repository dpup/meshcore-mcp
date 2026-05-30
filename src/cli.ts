#!/usr/bin/env node
/**
 * meshcore-mcp entrypoint.
 *
 * Reads {@link loadConfig configuration} from the environment (+ a few flags),
 * builds the live `MeshCoreClient` for the configured transport, wires the
 * {@link MeshService} (with a {@link SystemClock} and the config's credential
 * resolver), and serves the {@link createServer MCP server} over stdio — the
 * local-process transport an MCP client (Claude Code, or meshcore-elmer's
 * bridge) launches and speaks to (PRD §6).
 *
 * ### Startup ordering (transport-first)
 *
 * The stdio transport is connected **before** the device, so the MCP
 * `initialize` handshake works immediately and never blocks on the radio being
 * reachable. `service.start()` (connect + subscribe) then runs; if it rejects
 * (device unreachable at boot), the error is logged to stderr and the process
 * **keeps serving** — subsequent tool calls surface the device error through
 * the normal actionable-error path, rather than crashing the server.
 *
 * Note: stdout is the MCP protocol channel — all diagnostics go to **stderr**.
 */
import { join } from "node:path";

import { MeshCoreClient } from "@dpup/meshcore-ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SystemClock } from "./clock.js";
import { ConfigError, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createServer } from "./server.js";
import { MeshService } from "./service/mesh-service.js";
import {
  composeCredentials,
  CredentialStoreError,
  JsonFileCredentialStore,
} from "./store/credential-store.js";

/** Build the live `MeshCoreClient` for the configured transport. */
function buildClient(config: Config): MeshCoreClient {
  const options = {
    requestTimeoutMs: config.requestTimeoutMs,
    autoSync: true as const,
  };
  if (config.transport.kind === "tcp") {
    return MeshCoreClient.tcp(
      config.transport.host,
      config.transport.port,
      options,
    );
  }
  return MeshCoreClient.serial(config.transport.path, options);
}

/** A short, human description of the transport, for the stderr startup log. */
function describeTransport(config: Config): string {
  return config.transport.kind === "tcp"
    ? `tcp ${config.transport.host}:${config.transport.port}`
    : `serial ${config.transport.path}`;
}

async function main(): Promise<void> {
  // 1. Configuration. A ConfigError is the operator's problem to fix — print
  //    its actionable message to stderr and exit non-zero; never throw raw.
  //    Loading the persisted credential store happens here too: a malformed
  //    file is a startup error operators must address, on the same path.
  let config: Config;
  let credentialStore: JsonFileCredentialStore;
  try {
    config = loadConfig();
    credentialStore = new JsonFileCredentialStore({
      path: join(config.stateDir, "credentials.json"),
    });
  } catch (err) {
    if (err instanceof ConfigError || err instanceof CredentialStoreError) {
      process.stderr.write(`meshcore-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // 2–5. Build the stack: client ← transport config, service ← client + clock +
  //      credentials/tuning, server ← service. `composeCredentials` is the
  //      single source of truth for the layering precedence
  //      (store ⟶ env per-node ⟶ env default ⟶ guest) — production and the
  //      test harness both call it, so prod/test stay in lock-step.
  const client = buildClient(config);
  const clock = new SystemClock();
  const credentials = composeCredentials(credentialStore, config.credentials);
  const service = new MeshService(client, clock, {
    credentials,
    credentialStore,
    trafficCapacity: config.trafficCapacity,
    adminReplyTimeoutMs: config.adminReplyTimeoutMs,
  });
  const server = createServer({ service });

  // 6. Connect the stdio transport FIRST so `initialize` works immediately and
  //    does not depend on the radio being reachable.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 8. Graceful shutdown: stop the service then close the server, once.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`meshcore-mcp: ${signal} received, shutting down.\n`);
    void (async () => {
      try {
        await service.stop();
        await server.close();
      } catch (err) {
        process.stderr.write(`meshcore-mcp: error during shutdown: ${String(err)}\n`);
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 7. Connect to the device + subscribe. If the device is unreachable at boot,
  //    log and keep serving — tool calls will surface the device error. Catch it
  //    so it never becomes an unhandled rejection.
  process.stderr.write(
    `meshcore-mcp: serving over stdio; connecting to ${describeTransport(config)}.\n`,
  );
  try {
    await service.start();
    process.stderr.write("meshcore-mcp: device connected.\n");
  } catch (err) {
    process.stderr.write(
      `meshcore-mcp: device not reachable at startup (${String(err)}); ` +
        "serving anyway — tool calls will report device errors.\n",
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`meshcore-mcp: failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
