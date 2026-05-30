/**
 * Unit tests for the credential store — both implementations directly.
 *
 * The in-memory impl is exercised for round-trip behaviour; the JSON file
 * impl is exercised through an injected, in-memory {@link CredentialFs} so
 * we cover the load / write / atomic-rename / permissions paths without
 * touching real disk (mirrors the `FileReader` injection pattern in
 * `loadConfig`'s tests, src/config.ts:35).
 */

import { describe, expect, it } from "vitest";

import type { CredentialFs } from "../../src/store/credential-store.js";
import {
  CredentialStoreError,
  InMemoryCredentialStore,
  JsonFileCredentialStore,
  composeCredentials,
} from "../../src/store/credential-store.js";

// ---------------------------------------------------------------------------
// A minimal in-memory CredentialFs — enough surface for the JSON store's
// atomic-rename + perms semantics, with introspection hooks for assertions.
// ---------------------------------------------------------------------------

interface FakeFile {
  contents: string;
  mode: number;
}

interface FakeFs extends CredentialFs {
  files: Map<string, FakeFile>;
  dirs: Map<string, number>;
  chmodCalls: Array<{ path: string; mode: number }>;
  renameCalls: Array<{ from: string; to: string }>;
  accessCalls: Array<{ path: string; mode: number }>;
  /** When set, `access(path)` throws — simulates a non-writable dir. */
  denyWriteOn?: Set<string>;
}

function makeFakeFs(initial: Map<string, FakeFile> = new Map()): FakeFs {
  const files = new Map(initial);
  const dirs = new Map<string, number>();
  const chmodCalls: FakeFs["chmodCalls"] = [];
  const renameCalls: FakeFs["renameCalls"] = [];
  const accessCalls: FakeFs["accessCalls"] = [];
  const fs: FakeFs = {
    files,
    dirs,
    chmodCalls,
    renameCalls,
    accessCalls,
    readFile(path) {
      const f = files.get(path);
      if (f === undefined) {
        const err = new Error(`ENOENT: no such file, open '${path}'`) as Error & {
          code: string;
        };
        err.code = "ENOENT";
        throw err;
      }
      return f.contents;
    },
    writeFile(path, contents, mode) {
      // Match real fs: `mode` only applies on create.
      const existing = files.get(path);
      files.set(path, {
        contents,
        mode: existing === undefined ? mode : existing.mode,
      });
    },
    rename(oldPath, newPath) {
      renameCalls.push({ from: oldPath, to: newPath });
      const f = files.get(oldPath);
      if (f === undefined) {
        const err = new Error(`ENOENT: no such file, rename '${oldPath}'`) as Error & {
          code: string;
        };
        err.code = "ENOENT";
        throw err;
      }
      files.delete(oldPath);
      // Rename preserves the source mode (matches real fs).
      files.set(newPath, f);
    },
    mkdir(path, mode) {
      dirs.set(path, mode);
    },
    stat(path) {
      const f = files.get(path);
      if (f !== undefined) return { mode: f.mode };
      const d = dirs.get(path);
      if (d !== undefined) return { mode: d };
      const err = new Error(`ENOENT: stat '${path}'`) as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    },
    chmod(path, mode) {
      chmodCalls.push({ path, mode });
      const f = files.get(path);
      if (f !== undefined) f.mode = mode;
      const d = dirs.get(path);
      if (d !== undefined) dirs.set(path, mode);
    },
    access(path, mode) {
      accessCalls.push({ path, mode });
      if (fs.denyWriteOn?.has(path)) {
        const err = new Error(`EACCES: permission denied, access '${path}'`) as Error & {
          code: string;
        };
        err.code = "EACCES";
        throw err;
      }
    },
  };
  return fs;
}

// ---------------------------------------------------------------------------
// InMemoryCredentialStore
// ---------------------------------------------------------------------------

describe("InMemoryCredentialStore", () => {
  it("round-trips set/get/delete", async () => {
    const store = new InMemoryCredentialStore();
    expect(store.get("rocky")).toBeUndefined();

    await store.set("rocky", "rr-pw");
    expect(store.get("rocky")).toBe("rr-pw");

    await store.set("rocky", "rotated");
    expect(store.get("rocky")).toBe("rotated");

    await store.delete("rocky");
    expect(store.get("rocky")).toBeUndefined();
  });

  it("delete on an unknown node is a no-op (resolves, does not throw)", async () => {
    const store = new InMemoryCredentialStore();
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  it("nodes() lists every stored node, in insertion order", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("a", "1");
    await store.set("b", "2");
    await store.set("c", "3");
    expect(store.nodes()).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// composeCredentials
// ---------------------------------------------------------------------------

describe("composeCredentials", () => {
  it("returns the store entry when present, ignoring the baseline", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("rocky", "stored");
    const credentials = composeCredentials(store, () => "env-default");
    expect(credentials("rocky")).toBe("stored");
  });

  it("falls through to the baseline when the store has no entry", async () => {
    const store = new InMemoryCredentialStore();
    const credentials = composeCredentials(store, () => "env-default");
    expect(credentials("unknown")).toBe("env-default");
  });

  it("returns undefined when there is no entry and no baseline", () => {
    const store = new InMemoryCredentialStore();
    const credentials = composeCredentials(store, undefined);
    expect(credentials("unknown")).toBeUndefined();
  });

  it("preserves the baseline's per-node + default precedence (store wins outright)", async () => {
    const envMap: Record<string, string> = { rocky: "env-rocky" };
    const baseline = (n: string): string => envMap[n] ?? "env-default";
    const store = new InMemoryCredentialStore();
    const credentials = composeCredentials(store, baseline);

    // No store entry → baseline per-node.
    expect(credentials("rocky")).toBe("env-rocky");
    // No store entry, no baseline per-node → baseline default.
    expect(credentials("other")).toBe("env-default");
    // Store entry wins everything.
    await store.set("rocky", "from-store");
    expect(credentials("rocky")).toBe("from-store");
  });
});

// ---------------------------------------------------------------------------
// JsonFileCredentialStore — load semantics
// ---------------------------------------------------------------------------

describe("JsonFileCredentialStore (load)", () => {
  it("treats a missing file as an empty store", () => {
    const fs = makeFakeFs();
    const store = new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
    });
    expect(store.nodes()).toEqual([]);
    expect(store.get("anything")).toBeUndefined();
  });

  it("loads entries from an existing well-formed file", () => {
    const fs = makeFakeFs(
      new Map([
        [
          "/state/credentials.json",
          {
            contents: JSON.stringify({
              version: 1,
              nodes: { rocky: "rr-pw", dead: "d-pw" },
            }),
            mode: 0o600,
          },
        ],
      ]),
    );
    const store = new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
    });
    expect(store.get("rocky")).toBe("rr-pw");
    expect(store.get("dead")).toBe("d-pw");
    expect([...store.nodes()].sort()).toEqual(["dead", "rocky"]);
  });

  it("warns (does not throw) when an existing file has loose permissions", () => {
    const warnings: string[] = [];
    const fs = makeFakeFs(
      new Map([
        [
          "/state/credentials.json",
          {
            contents: JSON.stringify({ version: 1, nodes: {} }),
            mode: 0o644,
          },
        ],
      ]),
    );
    // Tight dir so this test isolates the file-perms warning.
    fs.dirs.set("/state", 0o700);
    new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
      warn: (m) => warnings.push(m),
    });
    expect(warnings.some((m) => m.includes("credentials.json") && m.includes("0644"))).toBe(true);
  });

  it("does not warn when permissions are tight", () => {
    const warnings: string[] = [];
    const fs = makeFakeFs(
      new Map([
        [
          "/state/credentials.json",
          {
            contents: JSON.stringify({ version: 1, nodes: {} }),
            mode: 0o600,
          },
        ],
      ]),
    );
    new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
  });

  it("throws a CredentialStoreError on malformed JSON", () => {
    const fs = makeFakeFs(
      new Map([
        ["/state/credentials.json", { contents: "{not json", mode: 0o600 }],
      ]),
    );
    expect(
      () => new JsonFileCredentialStore({ path: "/state/credentials.json", fs }),
    ).toThrow(CredentialStoreError);
    try {
      new JsonFileCredentialStore({ path: "/state/credentials.json", fs });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("not valid JSON");
      expect((err as Error).message).toContain("/state/credentials.json");
    }
  });

  it("throws on a file with the wrong shape", () => {
    const fs = makeFakeFs(
      new Map([
        [
          "/state/credentials.json",
          { contents: JSON.stringify({ version: 1, nodes: { a: 123 } }), mode: 0o600 },
        ],
      ]),
    );
    expect(
      () => new JsonFileCredentialStore({ path: "/state/credentials.json", fs }),
    ).toThrow(/unexpected shape/);
  });

  it("throws on a non-ENOENT read failure (e.g. permission denied)", () => {
    const fs = makeFakeFs();
    // Replace readFile with one that throws a non-ENOENT.
    fs.readFile = () => {
      const err = new Error("EACCES: permission denied") as Error & { code: string };
      err.code = "EACCES";
      throw err;
    };
    expect(
      () => new JsonFileCredentialStore({ path: "/state/credentials.json", fs }),
    ).toThrow(/could not read credentials file/);
  });
});

// ---------------------------------------------------------------------------
// JsonFileCredentialStore — write semantics
// ---------------------------------------------------------------------------

describe("JsonFileCredentialStore (write)", () => {
  it("writes atomically (.tmp → rename → chmod) and tightens the dir mode", async () => {
    const fs = makeFakeFs();
    const store = new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
    });
    await store.set("rocky", "rr-pw");

    // Atomic write: a .tmp was written, then renamed.
    expect(fs.renameCalls).toEqual([
      { from: "/state/credentials.json.tmp", to: "/state/credentials.json" },
    ]);
    // chmod applied to BOTH the dir (forces 0o700 even if pre-existed with
    // looser perms — closes the mkdir-mode-not-applied-to-existing gap) and
    // the file (belt+braces against a stale .tmp).
    expect(fs.chmodCalls).toEqual([
      { path: "/state", mode: 0o700 },
      { path: "/state/credentials.json", mode: 0o600 },
    ]);
    // Parent dir was ensured (mkdir requested 0o700; chmod enforced it).
    expect(fs.dirs.get("/state")).toBe(0o700);

    // File on disk matches.
    const written = fs.files.get("/state/credentials.json");
    expect(written?.mode).toBe(0o600);
    const parsed = JSON.parse(written?.contents ?? "");
    expect(parsed).toEqual({ version: 1, nodes: { rocky: "rr-pw" } });
  });

  it("tightens an existing loose state dir on construction (0o755 → 0o700)", async () => {
    const fs = makeFakeFs();
    // Pre-create the state dir with loose perms — simulates an operator
    // who mkdir'd it manually with default umask, or a leftover from a
    // different tool.
    fs.dirs.set("/state", 0o755);
    new JsonFileCredentialStore({ path: "/state/credentials.json", fs });

    // Construction chmod'd the dir down to 0o700 (the mkdir mode is a no-op
    // on pre-existing dirs in real fs — chmod is what actually tightens it).
    expect(fs.dirs.get("/state")).toBe(0o700);
    expect(fs.chmodCalls).toContainEqual({ path: "/state", mode: 0o700 });
  });

  it("ensureLeafDirMode runs once across construction + repeated writes (dirEnsured flag)", async () => {
    const fs = makeFakeFs();
    const store = new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
    });
    await store.set("a", "1");
    await store.set("b", "2");
    await store.set("c", "3");

    // mkdir called once (at construction). The dir chmod happens once too
    // (at construction); per-write persists do NOT re-chmod the dir.
    const dirChmods = fs.chmodCalls.filter((c) => c.path === "/state");
    expect(dirChmods).toEqual([{ path: "/state", mode: 0o700 }]);
  });

  it("fails fast at construction when the state dir is not writable", () => {
    const fs = makeFakeFs();
    fs.denyWriteOn = new Set(["/state"]);
    expect(
      () => new JsonFileCredentialStore({ path: "/state/credentials.json", fs }),
    ).toThrow(CredentialStoreError);
    expect(
      () => new JsonFileCredentialStore({ path: "/state/credentials.json", fs }),
    ).toThrow(/not usable/);
  });

  it("warns at load if the parent directory has loose permissions", () => {
    const warnings: string[] = [];
    const fs = makeFakeFs(
      new Map([
        [
          "/state/credentials.json",
          { contents: JSON.stringify({ version: 1, nodes: {} }), mode: 0o600 },
        ],
      ]),
    );
    fs.dirs.set("/state", 0o755);
    new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
      warn: (m) => warnings.push(m),
    });
    // The dir warning is emitted at load time (before construction tightens
    // it via chmod) — it tells the operator the file was sitting in a
    // world-listable directory.
    expect(warnings.some((m) => m.includes("/state") && m.includes("0755"))).toBe(true);
  });

  it("writes survive a fresh load (round-trip through disk)", async () => {
    const fs = makeFakeFs();
    const a = new JsonFileCredentialStore({ path: "/s/credentials.json", fs });
    await a.set("rocky", "rr-pw");
    await a.set("dead", "d-pw");
    await a.delete("dead");

    const b = new JsonFileCredentialStore({ path: "/s/credentials.json", fs });
    expect(b.get("rocky")).toBe("rr-pw");
    expect(b.get("dead")).toBeUndefined();
    expect(b.nodes()).toEqual(["rocky"]);
  });

  it("leaves in-memory state unchanged when persisting fails", async () => {
    const fs = makeFakeFs();
    const store = new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
    });
    await store.set("rocky", "rr-pw");
    expect(store.get("rocky")).toBe("rr-pw");

    // Make subsequent writes fail.
    fs.writeFile = () => {
      throw new Error("disk full");
    };
    await expect(store.set("rocky", "rotated")).rejects.toThrow(/disk full/);
    // The in-memory map still reflects the last successful write.
    expect(store.get("rocky")).toBe("rr-pw");
  });

  it("delete is a no-op (no disk write) when the node has no entry", async () => {
    const fs = makeFakeFs();
    const store = new JsonFileCredentialStore({
      path: "/state/credentials.json",
      fs,
    });
    await store.delete("ghost");
    expect(fs.renameCalls).toEqual([]);
    expect(fs.files.size).toBe(0);
  });
});
