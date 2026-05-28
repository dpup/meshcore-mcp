/**
 * Unit tests for {@link loadConfig} — env/flags → validated {@link Config}.
 *
 * Each case calls `loadConfig(fakeEnv, fakeArgv)` directly with a synthetic
 * environment and argv, so it never touches the real `process.env`. The focus
 * is the validation contract (PRD §6): exactly-one transport, numeric parsing,
 * the per-node credential resolver, and flag-over-env precedence.
 */

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  describe("transport selection", () => {
    it("accepts a TCP host with the default port", () => {
      const config = loadConfig({ MESHCORE_HOST: "192.168.1.50" }, []);
      expect(config.transport).toEqual({
        kind: "tcp",
        host: "192.168.1.50",
        port: 5000,
      });
    });

    it("accepts a TCP host with an explicit port", () => {
      const config = loadConfig(
        { MESHCORE_HOST: "node.local", MESHCORE_PORT: "5555" },
        [],
      );
      expect(config.transport).toEqual({
        kind: "tcp",
        host: "node.local",
        port: 5555,
      });
    });

    it("accepts a serial path", () => {
      const config = loadConfig({ MESHCORE_SERIAL_PATH: "/dev/ttyACM0" }, []);
      expect(config.transport).toEqual({
        kind: "serial",
        path: "/dev/ttyACM0",
      });
    });

    it("rejects neither host nor serial with an actionable message", () => {
      expect(() => loadConfig({}, [])).toThrow(ConfigError);
      try {
        loadConfig({}, []);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toContain("No transport configured");
        expect((err as ConfigError).message).toContain("MESHCORE_HOST");
        expect((err as ConfigError).message).toContain("MESHCORE_SERIAL_PATH");
      }
    });

    it("rejects both host and serial as ambiguous", () => {
      expect(() =>
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_SERIAL_PATH: "/dev/ttyACM0" },
          [],
        ),
      ).toThrow(ConfigError);
      try {
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_SERIAL_PATH: "/dev/ttyACM0" },
          [],
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as ConfigError).message).toContain("exactly one transport");
      }
    });

    it("treats an empty-string host as absent", () => {
      expect(() => loadConfig({ MESHCORE_HOST: "   " }, [])).toThrow(
        /No transport configured/,
      );
    });
  });

  describe("port parsing", () => {
    it("rejects a non-numeric MESHCORE_PORT", () => {
      expect(() =>
        loadConfig({ MESHCORE_HOST: "node.local", MESHCORE_PORT: "abc" }, []),
      ).toThrow(ConfigError);
      try {
        loadConfig({ MESHCORE_HOST: "node.local", MESHCORE_PORT: "abc" }, []);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as ConfigError).message).toContain("MESHCORE_PORT");
        expect((err as ConfigError).message).toContain("abc");
      }
    });

    it("rejects an out-of-range port", () => {
      expect(() =>
        loadConfig({ MESHCORE_HOST: "node.local", MESHCORE_PORT: "70000" }, []),
      ).toThrow(/MESHCORE_PORT/);
    });
  });

  describe("credentials resolver", () => {
    it("defaults to the guest password for every node", () => {
      const { credentials } = loadConfig({ MESHCORE_HOST: "node.local" }, []);
      expect(credentials("anything")).toBe("");
    });

    it("uses MESHCORE_LOGIN_PASSWORD as the default", () => {
      const { credentials } = loadConfig(
        { MESHCORE_HOST: "node.local", MESHCORE_LOGIN_PASSWORD: "secret" },
        [],
      );
      expect(credentials("rocky-ridge")).toBe("secret");
    });

    it("applies per-node overrides from MESHCORE_NODE_PASSWORDS", () => {
      const { credentials } = loadConfig(
        {
          MESHCORE_HOST: "node.local",
          MESHCORE_LOGIN_PASSWORD: "default-pw",
          MESHCORE_NODE_PASSWORDS: JSON.stringify({
            "rocky-ridge": "rr-pw",
            " a1b2c3 ": "by-key", // tolerate odd keys verbatim
          }),
        },
        [],
      );
      // Per-node override wins.
      expect(credentials("rocky-ridge")).toBe("rr-pw");
      // A node without an override falls back to the default.
      expect(credentials("other-node")).toBe("default-pw");
    });

    it("rejects malformed MESHCORE_NODE_PASSWORDS JSON", () => {
      expect(() =>
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_NODE_PASSWORDS: "{not json" },
          [],
        ),
      ).toThrow(ConfigError);
      try {
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_NODE_PASSWORDS: "{not json" },
          [],
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as ConfigError).message).toContain("MESHCORE_NODE_PASSWORDS");
        expect((err as ConfigError).message).toContain("valid JSON");
      }
    });

    it("rejects a non-string-valued MESHCORE_NODE_PASSWORDS object", () => {
      expect(() =>
        loadConfig(
          {
            MESHCORE_HOST: "node.local",
            MESHCORE_NODE_PASSWORDS: JSON.stringify({ a: 123 }),
          },
          [],
        ),
      ).toThrow(/MESHCORE_NODE_PASSWORDS/);
    });
  });

  describe("credentials from files (*_FILE)", () => {
    // An in-memory FileReader injected as loadConfig's 3rd arg — no real fs.
    const reader =
      (files: Record<string, string>) =>
      (p: string): string => {
        if (!(p in files)) throw new Error(`ENOENT: no such file, open '${p}'`);
        return files[p]!;
      };

    it("reads the node-password map from MESHCORE_NODE_PASSWORDS_FILE", () => {
      const { credentials } = loadConfig(
        {
          MESHCORE_HOST: "node.local",
          MESHCORE_LOGIN_PASSWORD: "default-pw",
          MESHCORE_NODE_PASSWORDS_FILE: "/secrets/nodes.json",
        },
        [],
        reader({ "/secrets/nodes.json": JSON.stringify({ "rocky-ridge": "rr-pw" }) }),
      );
      expect(credentials("rocky-ridge")).toBe("rr-pw"); // from the file
      expect(credentials("other")).toBe("default-pw"); // default still applies
    });

    it("reads the default login password from MESHCORE_LOGIN_PASSWORD_FILE, stripping a trailing newline", () => {
      const { credentials } = loadConfig(
        { MESHCORE_HOST: "node.local", MESHCORE_LOGIN_PASSWORD_FILE: "/secrets/login" },
        [],
        reader({ "/secrets/login": "filesecret\n" }),
      );
      expect(credentials("anything")).toBe("filesecret");
    });

    it("rejects setting both the inline var and its *_FILE", () => {
      expect(() =>
        loadConfig(
          {
            MESHCORE_HOST: "node.local",
            MESHCORE_NODE_PASSWORDS: "{}",
            MESHCORE_NODE_PASSWORDS_FILE: "/secrets/nodes.json",
          },
          [],
          reader({ "/secrets/nodes.json": "{}" }),
        ),
      ).toThrow(/not both/);
    });

    it("surfaces a file-read failure as an actionable ConfigError", () => {
      try {
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_NODE_PASSWORDS_FILE: "/nope.json" },
          [],
          reader({}),
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toContain("MESHCORE_NODE_PASSWORDS_FILE");
        expect((err as ConfigError).message).toContain("/nope.json");
      }
    });

    it("rejects malformed JSON in a node-passwords file", () => {
      expect(() =>
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_NODE_PASSWORDS_FILE: "/secrets/nodes.json" },
          [],
          reader({ "/secrets/nodes.json": "{not json" }),
        ),
      ).toThrow(/valid JSON/);
    });
  });

  describe("tuning", () => {
    it("applies sensible defaults", () => {
      const config = loadConfig({ MESHCORE_HOST: "node.local" }, []);
      expect(config.requestTimeoutMs).toBe(10_000);
      expect(config.adminReplyTimeoutMs).toBe(15_000);
      expect(config.trafficCapacity).toBeUndefined();
    });

    it("reads the tuning env vars", () => {
      const config = loadConfig(
        {
          MESHCORE_HOST: "node.local",
          MESHCORE_REQUEST_TIMEOUT_MS: "8000",
          MESHCORE_ADMIN_REPLY_TIMEOUT_MS: "20000",
          MESHCORE_TRAFFIC_CAPACITY: "250",
        },
        [],
      );
      expect(config.requestTimeoutMs).toBe(8000);
      expect(config.adminReplyTimeoutMs).toBe(20_000);
      expect(config.trafficCapacity).toBe(250);
    });

    it("rejects a non-numeric tuning value", () => {
      expect(() =>
        loadConfig(
          { MESHCORE_HOST: "node.local", MESHCORE_REQUEST_TIMEOUT_MS: "soon" },
          [],
        ),
      ).toThrow(/MESHCORE_REQUEST_TIMEOUT_MS/);
    });
  });

  describe("flag overrides", () => {
    it("lets --host / --port beat the env", () => {
      const config = loadConfig(
        { MESHCORE_HOST: "env-host", MESHCORE_PORT: "5000" },
        ["--host", "flag-host", "--port", "6000"],
      );
      expect(config.transport).toEqual({
        kind: "tcp",
        host: "flag-host",
        port: 6000,
      });
    });

    it("supports --flag=value syntax", () => {
      const config = loadConfig({}, ["--host=cli-host", "--port=7000"]);
      expect(config.transport).toEqual({
        kind: "tcp",
        host: "cli-host",
        port: 7000,
      });
    });

    it("lets --serial select the serial transport from a bare env", () => {
      const config = loadConfig({}, ["--serial", "/dev/ttyUSB0"]);
      expect(config.transport).toEqual({
        kind: "serial",
        path: "/dev/ttyUSB0",
      });
    });

    it("treats a --serial flag plus an env host as the ambiguous-both error", () => {
      expect(() =>
        loadConfig({ MESHCORE_HOST: "env-host" }, ["--serial", "/dev/ttyUSB0"]),
      ).toThrow(/exactly one transport/);
    });
  });
});
