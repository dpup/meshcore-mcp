/**
 * The injected credential store — the third device-independent seam in the
 * server stack (alongside {@link MeshCoreClient} and {@link Clock}, AGENTS.md
 * don't-regress #1).
 *
 * `meshcore-mcp` started with credentials frozen at startup from env vars
 * (`MESHCORE_LOGIN_PASSWORD` + `MESHCORE_NODE_PASSWORDS`). Real use needs
 * something more: an agent can learn a repeater's admin password at runtime
 * (e.g. over a DM) and must be able to *push it in* so subsequent `admin`
 * calls log in with it, and have that credential survive a restart.
 *
 * This module owns that persistence shape. The {@link CredentialStore}
 * interface is deliberately small — sync `get` (hot path, called inside
 * `runAdminRemote` / `remoteHealth`), async `set`/`delete` (write-through to
 * the backing store), and `nodes()` for diagnostics. Two implementations:
 *
 * - {@link InMemoryCredentialStore} — process-local, the test default.
 * - {@link JsonFileCredentialStore} — flat JSON file on disk, atomic writes,
 *   restrictive permissions. The production default.
 *
 * The *layering* (store ⟶ env per-node ⟶ env default ⟶ guest) is centralised
 * in {@link composeCredentials} and used by both `cli.ts` (production) and the
 * test harness, so the precedence rules live in one place and prod/test stay
 * in lock-step.
 *
 * SQLite was considered and rejected for the first cut: the runtime is Node
 * ≥18 (SQLite would mean a native dep), the credentials use case needs no
 * queries, and this interface keeps the door open to swap the backing store
 * later if/when we add history-bearing data (path observations, message log).
 */

import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { CredentialsProvider } from "../service/mesh-service.js";

/**
 * The credential-store contract: a small, store-agnostic surface the server
 * uses to look up and (at runtime) update the password it logs into a remote
 * node with. `get` is **sync** because it sits on the admin/remote-health hot
 * path; mutations are **async** because the prod impl writes through to disk.
 *
 * Returning `undefined` from {@link get} means "no entry" — the caller layers
 * env defaults underneath (see {@link composeCredentials}).
 */
export interface CredentialStore {
  /** Look up `node`'s stored password, or `undefined` if none. Sync — hot path. */
  get(node: string): string | undefined;
  /** Store (or overwrite) `node`'s password, write-through to the backing store. */
  set(node: string, password: string): Promise<void>;
  /** Remove `node`'s stored password. No-op when no entry exists. */
  delete(node: string): Promise<void>;
  /** Every node with a stored entry, in insertion order. For diagnostics. */
  nodes(): readonly string[];
}

/**
 * The process-local credential store: no persistence, no I/O. The default in
 * tests (where the sim-backed harness wants a clean slate per test).
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();

  get(node: string): string | undefined {
    return this.map.get(node);
  }

  async set(node: string, password: string): Promise<void> {
    this.map.set(node, password);
  }

  async delete(node: string): Promise<void> {
    this.map.delete(node);
  }

  nodes(): readonly string[] {
    return [...this.map.keys()];
  }
}

/**
 * Raised when {@link JsonFileCredentialStore} cannot load or persist the
 * backing file. The entrypoint (`cli.ts`) catches it on startup the same way
 * it catches `ConfigError` — print the actionable message to stderr and exit
 * non-zero, never let a raw stack escape.
 */
export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

/** The on-disk envelope. Versioned so future fields don't break old parsers. */
const fileSchema = z.object({
  version: z.literal(1),
  nodes: z.record(z.string(), z.string()),
});

/**
 * The narrow filesystem surface {@link JsonFileCredentialStore} needs. Injected
 * so unit tests can exercise the atomic-write + permissions logic without
 * touching real disk, mirroring how `loadConfig` already takes an injected
 * `FileReader` (src/config.ts).
 */
export interface CredentialFs {
  /** Read a UTF-8 file; throws (with `code: "ENOENT"`) if missing. */
  readFile(path: string): string;
  /** Create or replace a file, applying `mode` on create. */
  writeFile(path: string, contents: string, mode: number): void;
  /** Atomic move (same filesystem) — used to publish a freshly-written `.tmp`. */
  rename(oldPath: string, newPath: string): void;
  /**
   * Recursive `mkdir -p`. The `mode` argument is applied on create where the
   * platform honours it, but Node's `mkdirSync({recursive:true})` does **not**
   * tighten an existing directory and does not reliably apply `mode` to
   * intermediate dirs — {@link JsonFileCredentialStore} therefore chmods the
   * leaf explicitly after this returns.
   */
  mkdir(path: string, mode: number): void;
  /** Read a file's (or directory's) mode bits; throws if it does not exist. */
  stat(path: string): { mode: number };
  /**
   * Force a path's mode bits. {@link JsonFileCredentialStore} calls this on
   * both the leaf dir (to tighten an existing or umask-defaulted dir to
   * `DIR_MODE`) and the file after rename (belt+braces for a stale `.tmp`).
   */
  chmod(path: string, mode: number): void;
  /**
   * Test write access on `path` (`access(path, W_OK)`). Throws if the
   * path is not writable. Used at construction to fail-fast on a read-only
   * state dir instead of waiting for the first `set_credential` tool call.
   */
  access(path: string, mode: number): void;
}

/** Options for constructing a {@link JsonFileCredentialStore}. */
export interface JsonFileCredentialStoreOptions {
  /** Absolute path to the JSON file (e.g. `<stateDir>/credentials.json`). */
  path: string;
  /** Filesystem adapter; defaults to {@link defaultCredentialFs} (real `node:fs`). */
  fs?: CredentialFs;
  /** Diagnostic sink for non-fatal warnings; defaults to a stderr writer. */
  warn?: (message: string) => void;
}

/** Restrictive permissions for the directory holding credentials (`rwx------`). */
const DIR_MODE = 0o700;
/** Restrictive permissions for the credentials file (`rw-------`). */
const FILE_MODE = 0o600;
/** The mask of "others / group" bits — any set bit ⇒ loose perms. */
const LOOSE_BITS = 0o077;
/** `fs.constants.W_OK` mirror — write-access probe mode. */
const W_OK = constants.W_OK;

/**
 * Persisted credential store backed by a single JSON file. Loaded
 * synchronously on construction (fail-fast on a malformed file, matching the
 * existing `ConfigError` pattern); writes are atomic (`*.tmp` + `rename`) so a
 * crash mid-write can't leave a half-written file. The leaf state dir is
 * forced to `0o700` on first write (so a pre-existing loose dir is tightened),
 * and the file is forced to `0o600` after each rename. Loose permissions found
 * at load are warned, never thrown (operators may have set them deliberately).
 *
 * The store ensures the state directory exists and is writable at
 * construction time (`fs.access(W_OK)`), so a read-only `MESHCORE_STATE_DIR`
 * or a typo fails fast on startup rather than at the first `set_credential`
 * tool call. A missing file inside a writable dir is normal (treated as empty).
 */
export class JsonFileCredentialStore implements CredentialStore {
  private readonly path: string;
  private readonly fs: CredentialFs;
  private readonly warn: (message: string) => void;
  private map = new Map<string, string>();
  /**
   * `true` once {@link ensureLeafDirMode} has run successfully for the
   * lifetime of this store. The leaf-dir mkdir + chmod is idempotent but
   * issues syscalls every time; the flag elides them after the first success
   * so a hot `set_credential` loop doesn't repeatedly stat/mkdir/chmod the dir.
   */
  private dirEnsured = false;

  constructor(opts: JsonFileCredentialStoreOptions) {
    this.path = opts.path;
    this.fs = opts.fs ?? defaultCredentialFs();
    this.warn = opts.warn ?? ((m) => process.stderr.write(`meshcore-mcp: ${m}\n`));
    this.load();
    this.ensureLeafDirMode();
  }

  get(node: string): string | undefined {
    return this.map.get(node);
  }

  async set(node: string, password: string): Promise<void> {
    const next = new Map(this.map);
    next.set(node, password);
    // Persist first; commit in-memory only on success so a disk failure
    // leaves this process and a restarted one looking at the same map.
    this.persist(next);
    this.map = next;
  }

  async delete(node: string): Promise<void> {
    if (!this.map.has(node)) return;
    const next = new Map(this.map);
    next.delete(node);
    this.persist(next);
    this.map = next;
  }

  nodes(): readonly string[] {
    return [...this.map.keys()];
  }

  // --- internals ---------------------------------------------------------

  /**
   * Load the backing file into {@link map}. A missing file is normal (empty
   * map); a malformed or unreadable file is a {@link CredentialStoreError} so
   * the operator notices on startup rather than silently losing credentials.
   */
  private load(): void {
    let raw: string;
    try {
      raw = this.fs.readFile(this.path);
    } catch (err) {
      if (isENoent(err)) return;
      throw new CredentialStoreError(
        `could not read credentials file at "${this.path}": ${(err as Error).message}`,
      );
    }
    this.checkPerms();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CredentialStoreError(
        `credentials file at "${this.path}" is not valid JSON: ${(err as Error).message}`,
      );
    }
    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      throw new CredentialStoreError(
        `credentials file at "${this.path}" has an unexpected shape ` +
          `(expected { version: 1, nodes: { <node>: <password>, ... } }).`,
      );
    }
    for (const [k, v] of Object.entries(result.data.nodes)) {
      this.map.set(k, v);
    }
  }

  /**
   * Warn (never throw) if either the file or its parent directory has loose
   * permissions. A 0o600 file inside a 0o755 dir is still enumerable, so the
   * dir check matters as much as the file check.
   */
  private checkPerms(): void {
    this.warnIfLoose(this.path, FILE_MODE);
    this.warnIfLoose(dirname(this.path), DIR_MODE);
  }

  /** Stat `target` and warn if any group/other bit is set. Stat failures are silent. */
  private warnIfLoose(target: string, recommended: number): void {
    try {
      const st = this.fs.stat(target);
      const perms = st.mode & 0o777;
      if ((perms & LOOSE_BITS) !== 0) {
        this.warn(
          `credentials path "${target}" has loose permissions ` +
            `(mode 0${perms.toString(8)}); recommend 0${recommended.toString(8)}.`,
        );
      }
    } catch {
      // Ignore — perms are advisory; stat failures are not fatal.
    }
  }

  /**
   * Ensure the parent directory exists, has `DIR_MODE`, and is writable.
   * Called once at construction and again on the first {@link persist} (in
   * case the dir was removed between construction and a much-later write).
   * Idempotent via {@link dirEnsured}.
   *
   * `mkdirSync({recursive:true, mode})` does **not** tighten an existing dir
   * and does not reliably apply `mode` to intermediate XDG dirs, so we
   * explicitly `chmod` the leaf to `DIR_MODE`. Intermediates
   * (e.g. `~/.local`, `~/.local/state`) are intentionally left alone — those
   * are shared XDG dirs and tightening them would break other apps.
   */
  private ensureLeafDirMode(): void {
    if (this.dirEnsured) return;
    const dir = dirname(this.path);
    try {
      this.fs.mkdir(dir, DIR_MODE);
      this.fs.chmod(dir, DIR_MODE);
      this.fs.access(dir, W_OK);
    } catch (err) {
      throw new CredentialStoreError(
        `credentials directory "${dir}" is not usable: ${(err as Error).message}`,
      );
    }
    this.dirEnsured = true;
  }

  /**
   * Write `next` atomically: write to `<path>.tmp` with `0o600`, rename over
   * `<path>`, and force `0o600` again (the `mode` argument to `writeFileSync`
   * only applies on *create*, so a stale `.tmp` from a prior crashed write
   * would otherwise keep its old mode — chmod is the belt+braces).
   */
  private persist(next: Map<string, string>): void {
    this.ensureLeafDirMode();

    const nodesObj: Record<string, string> = {};
    for (const [k, v] of next) nodesObj[k] = v;
    const contents = JSON.stringify({ version: 1, nodes: nodesObj }, null, 2) + "\n";

    const tmp = `${this.path}.tmp`;
    try {
      this.fs.writeFile(tmp, contents, FILE_MODE);
      this.fs.rename(tmp, this.path);
      this.fs.chmod(this.path, FILE_MODE);
    } catch (err) {
      throw new CredentialStoreError(
        `could not write credentials file at "${this.path}": ${(err as Error).message}`,
      );
    }
  }
}

/**
 * The default {@link CredentialFs}: a thin wrapper over `node:fs`'s sync
 * primitives. Sync is fine — these are rare, small operations on a server
 * that has no concurrency model below the entrypoint.
 */
export function defaultCredentialFs(): CredentialFs {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c, mode) => writeFileSync(p, c, { mode }),
    rename: (a, b) => renameSync(a, b),
    mkdir: (p, mode) => mkdirSync(p, { recursive: true, mode }),
    stat: (p) => {
      const s = statSync(p);
      return { mode: s.mode };
    },
    chmod: (p, mode) => chmodSync(p, mode),
    access: (p, mode) => accessSync(p, mode),
  };
}

/**
 * Compose a {@link CredentialsProvider} that layers a runtime {@link CredentialStore}
 * over a baseline (typically the env-driven `config.credentials` callback).
 * The store wins where it has an entry; otherwise the baseline is consulted.
 *
 * This is the single source of truth for the precedence rule used by both
 * `cli.ts` (production) and the test harness — if the layering changes (cache,
 * extra source, reordering), update it here, not at two call sites.
 *
 * @param store - The runtime-managed store, written by `set_credential` /
 *   `forget_credential`. Always consulted first.
 * @param baseline - The env-default resolver (`config.credentials`). May be
 *   `undefined` in tests that don't supply one; in that case lookups fall
 *   through to `undefined`, which `MeshService.runAdminRemote` interprets as
 *   the guest password.
 */
export function composeCredentials(
  store: CredentialStore,
  baseline: CredentialsProvider | undefined,
): CredentialsProvider {
  return (node) => store.get(node) ?? baseline?.(node);
}

/** Recognise an ENOENT from a node fs error or any plain object with `code`. */
function isENoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
