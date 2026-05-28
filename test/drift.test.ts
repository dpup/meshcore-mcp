/**
 * Drift guard: assert the slice of `@dpup/meshcore-ts` and
 * `@modelcontextprotocol/sdk` that this server is wedged between (execution plan
 * §1 — "two contracts, one server") still matches the *installed* packages. This
 * runs in normal CI, so the moment either dependency is bumped, any divergence
 * — a renamed/removed `MeshCoreClient` method we call, a renamed device event we
 * bind, a moved SDK entry point we import, a changed `TxtType.CliData` value the
 * remote-admin path depends on — fails here, loudly, instead of silently
 * shipping a server that no longer fronts the libraries it wraps.
 *
 * It is the meshcore-mcp sibling of meshcore-ts's and meshcore-sim's own
 * `test/drift.test.ts`: those guard the wrapper↔raw and sim↔wrapper seams; this
 * one guards the *two* seams meshcore-mcp owns — the device client below
 * (`MeshService` → `MeshCoreClient`) and the MCP protocol above
 * (`createServer` → `McpServer` + the low-level subscription wiring M4 needs).
 *
 * The asserted sets are derived from the code, not hand-copied wishlists — keep
 * them in sync with:
 *   - methods: `grep -rhoE '\bclient\.[A-Za-z]+' src | sed 's/.*client\.//' | sort -u`
 *     plus the `MeshCoreClient.<static>` factories in `src/cli.ts`;
 *   - events:  `grep -rhoE 'this\.listen\("[A-Za-z]+"' src/service/mesh-service.ts`;
 *   - SDK:     the `@modelcontextprotocol/sdk/...` imports across `src/`.
 *
 * It can only check runtime *values, method presence, and emitted event-name
 * literals* — type-erased shape drift (the fields of `Contact`/`SelfInfo`/
 * `StatusResponse`/`ContactMessage` we read, the argument tuples of the device
 * events, the Zod-derived tool I/O schemas) is invisible at runtime and MUST be
 * reconciled by hand against the upstream diff when this (or an upstream drift
 * workflow) flags a release.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MeshCoreClient, TxtType } from "@dpup/meshcore-ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Contract below — @dpup/meshcore-ts MeshCoreClient
// ---------------------------------------------------------------------------

/**
 * Every instance method `MeshService`/`admin` invoke on the injected
 * `MeshCoreClient` (the `client.<method>(...)` / `this.client.<method>(...)`
 * calls across `src/`). If upstream renames or removes one, the wrong-shaped
 * client silently no-ops or throws at runtime; this fails first instead.
 */
const CLIENT_METHODS = [
  // lifecycle + event wiring (mesh-service.ts start/stop/subscribe)
  "connect",
  "close",
  "on",
  "off",
  // home-health reads (mesh-service.ts homeHealth/nodeHealth)
  "getSelfInfo",
  "getBatteryVoltage",
  "getDeviceTime",
  "getStatsCore",
  "getStatsRadio",
  "getStatsPackets",
  // roster + resolution (surveyMesh, resolveContact, resolveChannel)
  "getContacts",
  "findContactByName",
  "findContactByPublicKeyPrefix",
  "findChannelByName",
  "getChannel",
  "setChannel",
  "deleteChannel",
  // remote node reads (remoteHealth) + remote-admin handshake (runAdminRemote)
  "login",
  "getStatus",
  "getTelemetry",
  // transmit (sendMessage) + remote CliData (runAdminRemote)
  "sendTextMessage",
  "sendChannelTextMessage",
  // structured home-admin paths (service/admin.ts ADMIN_COMMANDS[*].home)
  "reboot",
  "setTxPower",
  "setRadioParams",
  "setAdvertName",
  "setAdvertLatLong",
  "syncDeviceTime",
  "sendFloodAdvert",
  "sendZeroHopAdvert",
] as const;

/**
 * The static factories `src/cli.ts` builds the production client with
 * (`MeshCoreClient.tcp(...)` / `MeshCoreClient.serial(...)`). They live on the
 * constructor, not the prototype, so they are checked separately.
 */
const CLIENT_STATICS = ["tcp", "serial"] as const;

describe("@dpup/meshcore-ts MeshCoreClient surface this server calls", () => {
  const proto = MeshCoreClient.prototype as unknown as Record<string, unknown>;

  it("every called instance method is present on MeshCoreClient.prototype", () => {
    const missing = CLIENT_METHODS.filter((name) => typeof proto[name] !== "function");
    expect(
      missing,
      `MeshCoreClient no longer defines: ${JSON.stringify(missing)} — upstream ` +
        `renamed/removed them; reconcile src/service/mesh-service.ts & src/service/admin.ts.`,
    ).toEqual([]);
  });

  it("the static transport factories cli.ts uses are present", () => {
    const ctor = MeshCoreClient as unknown as Record<string, unknown>;
    const missing = CLIENT_STATICS.filter((name) => typeof ctor[name] !== "function");
    expect(
      missing,
      `MeshCoreClient lost static factory(ies): ${JSON.stringify(missing)} — ` +
        `reconcile src/cli.ts buildClient().`,
    ).toEqual([]);
  });
});

describe("@dpup/meshcore-ts TxtType.CliData (the remote-admin transport)", () => {
  it("TxtType.CliData exists and equals 1", () => {
    // mesh-service.ts runAdminRemote sends each CLI line as
    // `sendTextMessage(contact, line, TxtType.CliData)`; the wire frame's type
    // byte must stay 1 or every remote `admin` command silently sends a plain
    // chat message instead of a CLI command (§6).
    expect(
      TxtType.CliData,
      "TxtType.CliData moved — remote admin (login → CliData → reply) depends on it being 1.",
    ).toBe(1);
  });
});

/**
 * The named device events `MeshService.subscribe()` binds, mapped to
 * `TrafficEvent`s. `MeshCoreEvents` is a TypeScript interface — erased at
 * runtime — so we cannot reflect its keys. But the wrapper *emits* each event
 * by name in its compiled `client.js` (`this.emit("<name>", …)`), and Node's
 * `EventEmitter` happily accepts any string for `.on`/`.off`, so a renamed
 * event would NOT surface by calling `.on`. Instead we assert each bound name
 * still appears as an `emit("<name>"` site in the installed `client.js`: if
 * upstream renames an event, the literal disappears and this fails, naming
 * exactly which binding in `mesh-service.ts` to reconcile.
 *
 * Type-level note (the limit, stated plainly like the siblings): this proves the
 * *names* still flow; it cannot prove the *payload shapes* (`ContactMessage`,
 * `ChannelMessage`, `ChannelData`, `Advert`/`NewAdvert`, `RawData`/`LogRxData`)
 * still carry the fields `record()` reads. Reconcile those by hand on a bump.
 */
const BOUND_EVENTS = [
  "contactMessage",
  "channelMessage",
  "channelData",
  "advert",
  "newAdvert",
  "rawData",
  "logRxData",
] as const;

describe("@dpup/meshcore-ts events MeshService binds are still emitted", () => {
  // Read the installed package's compiled client.js. The package's `exports`
  // map blocks both a subpath and a `/package.json` resolve, and
  // `import.meta.resolve` is unavailable under the test transform — so locate
  // the installed package directory by walking up from this test file, then
  // read its compiled entry's sibling client.js (resilient to the `main`/dist
  // layout via the package's own package.json).
  const clientSrc = readFileSync(installedFile("@dpup/meshcore-ts", "client.js"), "utf8");

  it("every bound event name appears as an emit() site in client.js", () => {
    const missing = BOUND_EVENTS.filter(
      (name) => !clientSrc.includes(`emit("${name}"`),
    );
    expect(
      missing,
      `MeshCoreClient no longer emits: ${JSON.stringify(missing)} — upstream ` +
        `renamed/removed the event(s); reconcile MeshService.subscribe() in ` +
        `src/service/mesh-service.ts (and the MeshCoreEvents type import).`,
    ).toEqual([]);
  });

  it("a real MeshCoreClient accepts on/off for each bound event", () => {
    // A weaker, type-erased check kept as a live sanity proof: `on`/`off` are
    // inherited from TypedEventEmitter and must exist and not throw for the
    // names we wire. (This alone can't catch a rename — see the emit() check
    // above — but it proves the subscription mechanism itself is intact.)
    const client = new MeshCoreClient(stubConnection());
    for (const name of BOUND_EVENTS) {
      const fn = (): void => {};
      expect(() => client.on(name, fn)).not.toThrow();
      expect(() => client.off(name, fn)).not.toThrow();
    }
  });
});

/**
 * Locate a file inside an installed package, relative to that package's own
 * compiled entry point. Walks up from this test file to find
 * `node_modules/<pkg>`, reads its `package.json` `main` to find the compiled
 * directory, and joins `file` there — so a `dist/` rename upstream is followed,
 * and a *moved* file fails loudly (which is the point: reconcile by hand).
 */
function installedFile(pkg: string, file: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgDir = join(dir, "node_modules", ...pkg.split("/"));
    const pkgJsonPath = join(pkgDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      const main = (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { main?: string })
        .main;
      const compiledDir = main === undefined ? pkgDir : dirname(join(pkgDir, main));
      return join(compiledDir, file);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not locate installed package "${pkg}" above ${fileURLToPath(import.meta.url)}`,
      );
    }
    dir = parent;
  }
}

/**
 * A minimal raw `Connection` double — just enough for `new MeshCoreClient(...)`
 * to construct without touching hardware. We never connect it; the event check
 * only exercises `on`/`off`, which delegate to the in-memory emitter.
 */
function stubConnection(): ConstructorParameters<typeof MeshCoreClient>[0] {
  return {
    on() {},
    off() {},
    once() {},
    emit() {},
    removeListener() {},
  } as unknown as ConstructorParameters<typeof MeshCoreClient>[0];
}

// ---------------------------------------------------------------------------
// Contract above — @modelcontextprotocol/sdk
// ---------------------------------------------------------------------------

describe("@modelcontextprotocol/sdk entry points this server imports", () => {
  it("the high-level + transport + client classes resolve as constructors", () => {
    // server.ts / cli.ts / test harness imports — a moved entry point throws at
    // import time, but assert the kind so a non-constructor export (e.g. a shape
    // change to a factory) is caught too.
    expect(typeof McpServer, "McpServer (server/mcp.js) is not a constructor").toBe(
      "function",
    );
    expect(
      typeof StdioServerTransport,
      "StdioServerTransport (server/stdio.js) is not a constructor",
    ).toBe("function");
    expect(typeof Client, "Client (client/index.js) is not a constructor").toBe(
      "function",
    );
    expect(
      typeof InMemoryTransport,
      "InMemoryTransport (inMemory.js) is not a constructor",
    ).toBe("function");
    expect(
      typeof InMemoryTransport.createLinkedPair,
      "InMemoryTransport.createLinkedPair() is gone — the test harness (§5) depends on it.",
    ).toBe("function");
  });

  it("McpServer.prototype exposes the registrars server.ts uses", () => {
    // createServer() and every tools/*, resources/*, prompts/index registrar
    // call exactly these.
    const proto = McpServer.prototype as unknown as Record<string, unknown>;
    for (const name of ["registerTool", "registerResource", "registerPrompt"] as const) {
      expect(
        typeof proto[name],
        `McpServer.prototype.${name} is gone — reconcile src/server.ts and the registrars.`,
      ).toBe("function");
    }
  });

  it("the low-level server exposes the M4 subscription wiring", () => {
    // resources/traffic-live.ts reaches through `server.server` for the
    // subscription surface the high-level McpServer does not handle itself.
    const server = new McpServer({ name: "drift", version: "0.0.0" });
    const low = server.server as unknown as Record<string, unknown>;
    for (const name of [
      "registerCapabilities",
      "setRequestHandler",
      "sendResourceUpdated",
    ] as const) {
      expect(
        typeof low[name],
        `Server.prototype.${name} is gone — reconcile src/resources/traffic-live.ts.`,
      ).toBe("function");
    }
  });

  it("the request/notification schemas traffic-live.ts handles are defined", () => {
    // setRequestHandler(SubscribeRequestSchema|UnsubscribeRequestSchema, …) and
    // the ResourceUpdatedNotification the subscribe path drives.
    for (const [label, schema] of [
      ["SubscribeRequestSchema", SubscribeRequestSchema],
      ["UnsubscribeRequestSchema", UnsubscribeRequestSchema],
      ["ResourceUpdatedNotificationSchema", ResourceUpdatedNotificationSchema],
    ] as const) {
      expect(
        typeof schema?.parse,
        `${label} (types.js) is no longer a Zod schema — reconcile src/resources/traffic-live.ts.`,
      ).toBe("function");
    }
  });
});
