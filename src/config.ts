/**
 * Configuration — env vars (+ a few flags) → a validated, typed {@link Config}.
 *
 * `meshcore-mcp` is a **local-process** server (PRD §6): its launcher (Claude
 * Code's MCP config, meshcore-elmer's bridge) hands it the home node's address
 * and, for remote admin, node credentials, through the environment. This module
 * reads that environment, validates it with Zod, and fails fast with a
 * **legible, actionable** {@link ConfigError} — naming the bad var and what was
 * expected — so a mis-wired launcher gets a usable message, not a stack trace.
 *
 * The shape it produces feeds `cli.ts`:
 * - **transport** → `MeshCoreClient.tcp(host, port)` or `.serial(path)`;
 * - **credentials** → the {@link MeshServiceOptions} `credentials` resolver
 *   (per-node override else a default login/admin password);
 * - **tuning** → the client's `requestTimeoutMs`, the traffic buffer capacity,
 *   and the admin reply timeout.
 *
 * Nothing here reads time or touches the device. The only I/O is reading a
 * `*_FILE` secret (e.g. `MESHCORE_NODE_PASSWORDS_FILE`) through an **injected**
 * {@link FileReader} — so the unit tests call {@link loadConfig} with a fake
 * `env`/`argv` and an in-memory reader, never the real `process.env` or disk.
 */

import { readFileSync } from "node:fs";

import { z } from "zod";

import type { CredentialsProvider } from "./service/mesh-service.js";

/**
 * Reads a file's UTF-8 contents by path. Injected into {@link loadConfig} so its
 * `*_FILE` secret handling stays unit-testable without touching the real
 * filesystem (tests pass an in-memory reader; production uses the default below).
 */
export type FileReader = (path: string) => string;

/** The default {@link FileReader}: a synchronous UTF-8 read from disk. */
const defaultFileReader: FileReader = (path) => readFileSync(path, "utf8");

/** Default TCP port for `companion_radio_wifi` (matches meshcore's WiFi companion). */
const DEFAULT_PORT = 5000;
/** Default client request timeout, in ms (mirrors meshcore-ts's own default). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Default remote-admin CLI reply timeout, in ms (mirrors `MeshService`'s default). */
const DEFAULT_ADMIN_REPLY_TIMEOUT_MS = 15_000;

/**
 * A validated server configuration. Either a TCP transport (the
 * `companion_radio_wifi` path) **or** a serial transport — never both, never
 * neither — plus the credential resolver and the tuning knobs `cli.ts` threads
 * into the client and {@link MeshService}.
 */
export interface Config {
  /** The selected device transport. Exactly one variant. */
  transport:
    | { kind: "tcp"; host: string; port: number }
    | { kind: "serial"; path: string };
  /**
   * Resolve a node's login/admin password: a per-node override (from
   * `MESHCORE_NODE_PASSWORDS`) else the default (`MESHCORE_LOGIN_PASSWORD`,
   * default `""` — the guest password). Feeds `MeshService`'s `credentials`.
   */
  credentials: CredentialsProvider;
  /** Client request timeout, in ms (→ `ClientOptions.requestTimeoutMs`). */
  requestTimeoutMs: number;
  /** Recent-traffic ring-buffer capacity (→ `MeshServiceOptions.trafficCapacity`). */
  trafficCapacity: number | undefined;
  /** Remote-admin CLI reply timeout, in ms (→ `MeshServiceOptions.adminReplyTimeoutMs`). */
  adminReplyTimeoutMs: number;
}

/**
 * Thrown by {@link loadConfig} when the environment (or flags) is invalid or
 * incomplete. Its `message` is the actionable diagnostic — `cli.ts` prints it
 * to **stderr** and exits non-zero; it never lets a raw Zod error escape.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Minimal flag parsing — `--host`, `--port`, `--serial` — with no new
 * dependency. Each, when present, overrides the corresponding env var. Accepts
 * both `--flag value` and `--flag=value`. Unknown flags are ignored (the
 * launcher owns the process; this is not a general-purpose CLI).
 */
function parseFlags(argv: readonly string[]): {
  host?: string;
  port?: string;
  serial?: string;
} {
  const out: { host?: string; port?: string; serial?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    for (const name of ["host", "port", "serial"] as const) {
      const prefix = `--${name}`;
      if (arg === prefix) {
        // `--flag value` — consume the next token as the value.
        const next = argv[i + 1];
        if (next !== undefined) {
          out[name] = next;
          i++;
        }
      } else if (arg.startsWith(`${prefix}=`)) {
        // `--flag=value`.
        out[name] = arg.slice(prefix.length + 1);
      }
    }
  }
  return out;
}

/** Read a var, treating an empty/whitespace-only string as absent. */
function readVar(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse a required-numeric env var, throwing a {@link ConfigError} naming the
 * var when it is present but not a finite positive integer. Returns the
 * `fallback` when the var is absent.
 */
function parseNumericVar(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = readVar(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${key} must be a positive integer (got "${raw}").`,
    );
  }
  return value;
}

/** Zod schema for the per-node password map: `{ [nodeIdOrName]: password }`. */
const nodePasswordsSchema = z.record(z.string());

/**
 * Parse `MESHCORE_NODE_PASSWORDS` (a JSON object of nodeId/name → password) into
 * a map, throwing a {@link ConfigError} with a legible message on malformed JSON
 * or a non-string-valued object.
 */
function parseNodePasswords(
  raw: string | undefined,
): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `MESHCORE_NODE_PASSWORDS must be valid JSON (an object mapping node id/name → password): ${detail}.`,
    );
  }
  const result = nodePasswordsSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `MESHCORE_NODE_PASSWORDS must be a JSON object mapping node id/name → string password.`,
    );
  }
  return result.data;
}

/**
 * Build the {@link Config.credentials} resolver: a per-node override (by id or
 * name) else the default login password. Returns `undefined` only when there is
 * genuinely nothing to return — but since the default is always at least `""`,
 * it always returns a string (the guest password).
 */
function makeCredentials(
  defaultPassword: string,
  perNode: Record<string, string>,
): CredentialsProvider {
  return (node: string): string => {
    const override = perNode[node];
    return override ?? defaultPassword;
  };
}

/**
 * Resolve a value that may be supplied **inline** (`KEY`) or **from a file**
 * (`KEY_FILE`), never both — returns the file's contents, else the inline value,
 * else `undefined`. Lets a secret (node passwords, the login password) live in a
 * file with restricted perms instead of the process environment / the launcher's
 * MCP config. Throws a {@link ConfigError} naming the vars if both are set, or if
 * the file cannot be read.
 */
function resolveEnvOrFile(
  env: NodeJS.ProcessEnv,
  readFile: FileReader,
  key: string,
): string | undefined {
  const inline = readVar(env, key);
  const path = readVar(env, `${key}_FILE`);
  if (inline !== undefined && path !== undefined) {
    throw new ConfigError(
      `Set ${key} or ${key}_FILE, not both — they configure the same value.`,
    );
  }
  if (path === undefined) return inline;
  try {
    return readFile(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${key}_FILE: could not read "${path}" (${detail}).`);
  }
}

/** Strip trailing line terminators — a password file's editor-added newline. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/[\r\n]+$/, "");
}

/**
 * Read and validate the server configuration from `env` (default
 * `process.env`) and `argv` (default the process args after `node script`).
 *
 * **Transport (required, exactly one):**
 * - TCP — `MESHCORE_HOST` (+ optional `MESHCORE_PORT`, default `5000`), the
 *   `companion_radio_wifi` path; or
 * - serial — `MESHCORE_SERIAL_PATH`.
 *
 * Setting neither, or both, is a {@link ConfigError}. The `--host`/`--port`
 * flags override the TCP env; `--serial` overrides the serial env.
 *
 * **Credentials (optional):** `MESHCORE_LOGIN_PASSWORD` (default `""`, guest)
 * is the default login/admin password; `MESHCORE_NODE_PASSWORDS` (JSON object)
 * supplies per-node overrides. Either may instead be read from a file via a
 * `*_FILE` variant (`MESHCORE_LOGIN_PASSWORD_FILE` /
 * `MESHCORE_NODE_PASSWORDS_FILE`) — the same content, kept off the environment;
 * set the inline var **or** its `*_FILE`, never both. A password file's trailing
 * newline is stripped.
 *
 * **Tuning (optional):** `MESHCORE_REQUEST_TIMEOUT_MS`,
 * `MESHCORE_TRAFFIC_CAPACITY`, `MESHCORE_ADMIN_REPLY_TIMEOUT_MS` — positive
 * integers, with sensible defaults.
 *
 * @throws {ConfigError} On any invalid/missing/ambiguous configuration, with an
 *   actionable message naming the offending var.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  readFile: FileReader = defaultFileReader,
): Config {
  const flags = parseFlags(argv);

  // Flags override env for the transport selectors.
  const host = flags.host ?? readVar(env, "MESHCORE_HOST");
  const serialPath = flags.serial ?? readVar(env, "MESHCORE_SERIAL_PATH");

  const hasTcp = host !== undefined;
  const hasSerial = serialPath !== undefined;

  if (hasTcp && hasSerial) {
    throw new ConfigError(
      "Configure exactly one transport, but both were set: a TCP host " +
        "(MESHCORE_HOST / --host) and a serial path (MESHCORE_SERIAL_PATH / " +
        "--serial). Unset one.",
    );
  }
  if (!hasTcp && !hasSerial) {
    throw new ConfigError(
      "No transport configured. Set either MESHCORE_HOST (the " +
        "companion_radio_wifi TCP host, with optional MESHCORE_PORT, default " +
        `${DEFAULT_PORT}) or MESHCORE_SERIAL_PATH (a serial device path). ` +
        "Flags --host / --port / --serial override these.",
    );
  }

  let transport: Config["transport"];
  if (hasTcp) {
    // Port: a `--port` flag overrides `MESHCORE_PORT`. Validate whichever is set.
    const portRaw = flags.port ?? readVar(env, "MESHCORE_PORT");
    let port: number;
    if (portRaw === undefined) {
      port = DEFAULT_PORT;
    } else {
      const value = Number(portRaw);
      if (
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0 ||
        value > 65_535
      ) {
        throw new ConfigError(
          `MESHCORE_PORT (or --port) must be a TCP port number 1–65535 (got "${portRaw}").`,
        );
      }
      port = value;
    }
    transport = { kind: "tcp", host, port };
  } else {
    // hasSerial is true here; assert for the narrowing the boolean alias hides.
    if (serialPath === undefined) {
      throw new ConfigError("No transport configured.");
    }
    transport = { kind: "serial", path: serialPath };
  }

  // Credentials may be inline or from a `*_FILE` secret on disk, never both.
  const loginRaw = resolveEnvOrFile(env, readFile, "MESHCORE_LOGIN_PASSWORD");
  const defaultPassword = loginRaw === undefined ? "" : stripTrailingNewlines(loginRaw);
  const perNode = parseNodePasswords(
    resolveEnvOrFile(env, readFile, "MESHCORE_NODE_PASSWORDS"),
  );
  const credentials = makeCredentials(defaultPassword, perNode);

  const requestTimeoutMs = parseNumericVar(
    env,
    "MESHCORE_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const adminReplyTimeoutMs = parseNumericVar(
    env,
    "MESHCORE_ADMIN_REPLY_TIMEOUT_MS",
    DEFAULT_ADMIN_REPLY_TIMEOUT_MS,
  );
  // Capacity is optional: absent ⇒ undefined ⇒ the TrafficBuffer default.
  const trafficCapacityRaw = readVar(env, "MESHCORE_TRAFFIC_CAPACITY");
  const trafficCapacity =
    trafficCapacityRaw === undefined
      ? undefined
      : parseNumericVar(env, "MESHCORE_TRAFFIC_CAPACITY", 0);

  return {
    transport,
    credentials,
    requestTimeoutMs,
    trafficCapacity,
    adminReplyTimeoutMs,
  };
}
