/**
 * Subprocess smoke tests for the built `dist/cli.js` entrypoint (M6).
 *
 * These spawn the real `node dist/cli.js`, isolated from the test's own
 * environment (only `PATH` is passed through), and assert two contract points
 * from the PRD §6 done-when:
 *
 * 1. **Bad config** (empty env) → the process exits **non-zero** and stderr
 *    carries an actionable message. (Stdout is the MCP channel; diagnostics go
 *    to stderr.)
 * 2. **Valid-but-unreachable config** (`MESHCORE_HOST=127.0.0.1:1`, a port that
 *    refuses) → piping a JSON-RPC `initialize` to stdin still yields a response
 *    over stdout whose `serverInfo.name === "meshcore-mcp"`. The handshake must
 *    not depend on the device connecting (transport-first startup).
 *
 * The suite builds `dist/` in `beforeAll` so it is self-sufficient. Generous
 * timeouts and explicit process teardown keep it from being flaky.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = resolve(repoRoot, "dist", "cli.js");

/** Spawn the built CLI with a controlled environment (no inherited env). */
function spawnCli(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [cliPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeAll(async () => {
  // Self-sufficient: ensure dist/cli.js exists before the subprocess cases run.
  await execFileAsync("bun", ["run", "build"], { cwd: repoRoot });
}, 120_000);

describe("cli smoke", () => {
  it("exits non-zero with an actionable message on bad config", async () => {
    // Empty env (only PATH) — no transport configured.
    const child = spawnCli({ PATH: process.env.PATH ?? "" });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const code = await new Promise<number | null>((resolveCode, reject) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("cli did not exit on bad config within 10s"));
      }, 10_000);
      child.on("exit", (exitCode) => {
        clearTimeout(killTimer);
        resolveCode(exitCode);
      });
      child.on("error", reject);
    });

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/transport/i);
    expect(stderr).toMatch(/MESHCORE_HOST|MESHCORE_SERIAL_PATH/);
  }, 20_000);

  it("answers initialize over stdio even when the device is unreachable", async () => {
    // Valid config, but 127.0.0.1:1 refuses — the handshake must not depend on it.
    const child = spawnCli({
      PATH: process.env.PATH ?? "",
      MESHCORE_HOST: "127.0.0.1",
      MESHCORE_PORT: "1",
    });

    let stdout = "";
    const response = new Promise<Record<string, unknown>>((resolveResp, reject) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`no initialize response within 10s; stdout so far: ${stdout}`));
      }, 10_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        // Responses are newline-delimited JSON-RPC. Scan complete lines for ours.
        let nl: number;
        while ((nl = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, nl).trim();
          stdout = stdout.slice(nl + 1);
          if (line === "") continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.id === 1 && "result" in msg) {
              clearTimeout(killTimer);
              resolveResp(msg);
              return;
            }
          } catch {
            // Partial / non-JSON line — keep reading.
          }
        }
      });
      child.on("error", reject);
      child.on("exit", (exitCode) => {
        clearTimeout(killTimer);
        reject(new Error(`cli exited (code ${exitCode}) before responding to initialize`));
      });
    });

    // A single JSON-RPC initialize request line → one response line (the M0 shape).
    const initialize =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "cli-smoke", version: "0.0.0" },
        },
      }) + "\n";
    child.stdin.write(initialize);

    try {
      const msg = await response;
      const result = msg.result as { serverInfo?: { name?: string } };
      expect(result.serverInfo?.name).toBe("meshcore-mcp");
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});
