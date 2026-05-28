/**
 * `MeshService` — the device-facing core every tool, resource, and prompt calls.
 *
 * It is the seam the whole test strategy hangs on (execution plan §1): it takes
 * its {@link MeshCoreClient} and {@link Clock} by **injection** and constructs
 * neither. In production the entrypoint builds `MeshCoreClient.tcp(host, port)`
 * with a {@link SystemClock}; in tests it builds
 * `new MeshCoreClient(sim.asConnection())` with a `SimClock`. Nothing in here
 * knows — or may assume — which it got, and nothing here reads `Date.now()` or
 * schedules a native timer directly (PRD §6).
 *
 * Its one M1 job is to be the **live-traffic listener**: {@link start} connects
 * the client, subscribes to its named events, and maps each into a
 * {@link TrafficEvent} stamped with the injected clock and tagged with
 * structural provenance (the table below), feeding the {@link TrafficBuffer}.
 * {@link recentTraffic} reads that buffer back. The intent-shaped methods the
 * tools will call (`nodeHealth`, `surveyMesh`, `sendMessage`, `runAdmin`) land
 * in M2/M3.
 *
 * ### Event → TrafficEvent provenance mapping (M4 depends on this being exact)
 *
 * | meshcore-ts event       | kind          | decryptVerified | fields                    |
 * | ----------------------- | ------------- | --------------- | ------------------------- |
 * | `contactMessage`        | `contact`     | `true`          | sender=pubKeyPrefix, text |
 * | `channelMessage`        | `channel`     | `true`          | channelIdx, text          |
 * | `channelData`           | `channelData` | `false`         | channelIdx, snr           |
 * | `advert` / `newAdvert`  | `advert`      | `false`         | sender=publicKey          |
 * | `rawData` / `logRxData` | `raw`         | `false`         | rssi, snr                 |
 */

import type {
  Channel,
  Contact,
  ContactMessage,
  MeshCoreClient,
  MeshCoreEvents,
  SelfInfo,
  SendConfirmed,
  Stats,
  TraceData,
} from "@dpup/meshcore-ts";

import { fromHex, MeshCoreError, TxtType } from "@dpup/meshcore-ts";

import { randomBytes } from "node:crypto";

import type { Clock, TimerHandle } from "../clock.js";
import { withRetry } from "../retry.js";
import type { AdminCommandDef, RiskTier } from "./admin.js";
import { ADMIN_COMMANDS } from "./admin.js";
import type { MeshSurvey, NodeHealth, SurveyContact } from "./health.js";
import { TrafficBuffer } from "./traffic-buffer.js";
import type { TrafficEvent, TrafficKind } from "./traffic-buffer.js";

/**
 * Thrown by {@link MeshService.nodeHealth} when `node` matches no known contact
 * (and is not the home node). A {@link MeshCoreError} subclass so the tool
 * layer's error formatter handles it on the same path as device errors.
 */
export class MeshServiceUnknownNodeError extends MeshCoreError {
  constructor(node: string) {
    super(`No contact matches "${node}"`);
    this.name = "MeshServiceUnknownNodeError";
  }
}

/**
 * Thrown by {@link MeshService.sendMessage} when a `#`-prefixed target resolves
 * to no channel — channel-aware, unlike the generic contact miss (H6). Carries
 * a hint listing the known channels.
 */
export class MeshServiceUnknownChannelError extends MeshCoreError {
  constructor(target: string, hint: string) {
    super(`no channel matches "${target}".${hint}`);
    this.name = "MeshServiceUnknownChannelError";
  }
}

/**
 * Thrown by {@link MeshService.runAdmin} when the request is malformed before
 * any device contact: an unknown `command`, params that fail the command's Zod
 * schema, or a scope mismatch (a `remote-only` command targeting the home
 * node). A {@link MeshCoreError} subclass so the tool layer's error formatter
 * surfaces it on the same `isError` path as device errors — actionable, never a
 * crash.
 */
export class AdminCommandError extends MeshCoreError {
  constructor(message: string) {
    super(message);
    this.name = "AdminCommandError";
  }
}

/**
 * The result of {@link MeshService.sendMessage}. A small, structured digest of
 * what was transmitted and where — not the raw `SentResult` frame.
 */
export interface SendMessageResult {
  /** How the target was resolved. */
  kind: "contact" | "channel";
  /** The resolved contact's display name (for `kind: "contact"`). */
  contact?: string;
  /** The resolved contact's hex public key (for `kind: "contact"`). */
  publicKey?: string;
  /** The resolved channel index (for `kind: "channel"`). */
  channelIdx?: number;
  /** The resolved channel name, where known (for `kind: "channel"`). */
  channelName?: string;
  /** The text transmitted. */
  text: string;
  /** How the device routed a contact send: `"direct"` or flood. */
  route?: "direct" | "flood";
  /**
   * Delivery confirmation — present only when `confirm` was requested for a
   * **contact** send (channels/broadcasts aren't acked). `true` once the
   * recipient's ack arrived; `false` if none did within the window.
   */
  delivered?: boolean;
  /** Round-trip time of the delivery ack in ms, when `delivered`. */
  roundTripMs?: number;
}

/**
 * The result of {@link MeshService.runAdmin}. A discriminated digest covering
 * the three outcomes:
 *
 * - **dry-run** — `dryRun: true`, a synthesized `preview`, no device contact;
 * - **home exec** — `dryRun: false`, dispatched via the structured
 *   `MeshCoreClient` method (no `reply`);
 * - **remote exec** — `dryRun: false`, dispatched via the
 *   `login → CliData → reply` handshake (carries the repeater's `reply` text).
 *
 * Every variant carries the `command` and its `tier` so the tool can surface
 * the per-command risk in its structured output.
 */
export interface AdminResult {
  /** The command that ran (its registry name). */
  command: string;
  /** The command's risk tier (execution plan §9). */
  tier: RiskTier;
  /** Whether this was a dry-run (no device contact). */
  dryRun: boolean;
  /** Where the command was dispatched (absent for a dry-run). */
  via?: "home" | "remote";
  /** The synthesized intent preview — present iff `dryRun`. */
  preview?: string;
  /** The repeater's CLI reply text — present for a remote exec. */
  reply?: string;
}

/** One hop of a {@link TraceResult} — a repeater on the path, with its SNR. */
export interface TraceHop {
  /** The repeater's path hash (hex), as carried in the trace. */
  hash: string;
  /** Signal-to-noise ratio reported at this hop, in dB. */
  snr: number;
}

/** The result of {@link MeshService.tracePath} — a completed route trace. */
export interface TraceResult {
  /** Always `true` here — a trace that doesn't complete rejects (timeout). */
  completed: boolean;
  /** Number of hops (repeaters) on the traced path. */
  hopCount: number;
  /** Per-hop hash + SNR, in path order. */
  hops: TraceHop[];
  /** SNR of the final hop, in dB. */
  lastSnr: number;
}

/**
 * Parse a trace `path` argument into raw hop bytes. Accepts the conventional
 * comma-separated hex bytes (`"23,5f,3a"`) or a contiguous hex string
 * (`"235f3a"`). Each hop is a 1-byte repeater path hash (the default size).
 */
function parseTracePath(path: string): Uint8Array {
  const cleaned = path.trim();
  if (cleaned === "") throw new MeshCoreError("empty trace path");
  if (cleaned.includes(",")) {
    return new Uint8Array(
      cleaned.split(",").map((part) => {
        const h = part.trim();
        if (!/^[0-9a-fA-F]{1,2}$/.test(h)) {
          throw new MeshCoreError(`invalid trace hop "${h}" — expected a hex byte`);
        }
        return parseInt(h, 16);
      }),
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new MeshCoreError(
      `invalid trace path "${path}" — expected comma-separated hex bytes (e.g. "23,5f,3a") or a hex string`,
    );
  }
  return fromHex(cleaned);
}

/** Map a meshcore-ts {@link TraceData} into the friendlier {@link TraceResult}. */
function toTraceResult(trace: TraceData): TraceResult {
  const hashes = trace.pathHashes.match(/.{2}/g) ?? [];
  const hops: TraceHop[] = trace.pathSnrs.map((snr, i) => ({ hash: hashes[i] ?? "", snr }));
  return { completed: true, hopCount: trace.pathLen, hops, lastSnr: trace.lastSnr };
}

/**
 * Resolve a node's admin/login password. Injected so config (M6) can supply
 * per-node credentials without `MeshService` knowing where they came from.
 * Returning `undefined` (or no provider at all) means "guest" — the empty
 * password.
 */
export type CredentialsProvider = (node: string) => string | undefined;

/** Options for constructing a {@link MeshService}. */
export interface MeshServiceOptions {
  /**
   * Capacity of the recent-traffic ring buffer. Defaults to the
   * {@link TrafficBuffer} default (~500 events).
   */
  trafficCapacity?: number;
  /**
   * Resolve a node's admin/login password for the remote-{@link MeshService.nodeHealth}
   * path. Defaults to the guest password (`""`) for every node. M6 wires this
   * from config; M2 only plumbs the seam.
   */
  credentials?: CredentialsProvider;
  /**
   * How long {@link MeshService.runAdmin}'s remote path waits for the repeater's CLI reply
   * before giving up, as injected-clock ms. Scheduled on the {@link Clock} (never
   * a native timer). Defaults to 15s.
   */
  adminReplyTimeoutMs?: number;
}

/** Default wait for a remote admin CLI reply, in injected-clock ms. */
const DEFAULT_ADMIN_REPLY_TIMEOUT_MS = 15_000;

/**
 * The device-facing core: an injected {@link MeshCoreClient} + {@link Clock},
 * a recent-traffic buffer, and (later) the intent-shaped methods the MCP tools
 * call.
 *
 * @example
 * ```ts
 * const service = new MeshService(client, clock);
 * await service.start();
 * // ... traffic arrives as the clock advances ...
 * const events = service.recentTraffic();
 * await service.stop();
 * ```
 */
export class MeshService {
  /** The injected device client. Never constructed here. */
  private readonly client: MeshCoreClient;
  /** The injected clock. Sole source of time — no `Date.now()` below here. */
  private readonly clock: Clock;
  /** The recent-traffic ring buffer, fed by the event subscriptions. */
  private readonly buffer: TrafficBuffer;
  /** Resolve a node's login password; `undefined` ⇒ guest (`""`). */
  private readonly credentials: CredentialsProvider | undefined;
  /** How long the remote admin path waits for a CLI reply, in clock ms. */
  private readonly adminReplyTimeoutMs: number;
  /** Monotonic counter behind the `evt-<n>` ids. */
  private nextEventSeq = 1;
  /** Whether {@link start} has run (and subscriptions are live). */
  private started = false;
  /** The bound listeners, retained so {@link stop} can detach exactly these. */
  private readonly listeners: Array<{
    event: keyof MeshCoreEvents & string;
    fn: (...args: never[]) => void;
  }> = [];
  /** Reconnect-daemon state — see {@link onClientDisconnected}. */
  private reconnectAttempt = 0;
  private reconnectScheduled = false;
  private stopping = false;
  private readonly onClientDisconnected: () => void;

  /**
   * @param client - An already-built {@link MeshCoreClient} (real or sim-backed).
   * @param clock - The injected {@link Clock} (`SystemClock` in prod, `SimClock`
   *   in tests). Stamps every buffered event.
   * @param options - Optional tuning (see {@link MeshServiceOptions}).
   */
  constructor(
    client: MeshCoreClient,
    clock: Clock,
    options: MeshServiceOptions = {},
  ) {
    this.client = client;
    this.clock = clock;
    this.buffer = new TrafficBuffer(options.trafficCapacity);
    this.credentials = options.credentials;
    this.adminReplyTimeoutMs =
      options.adminReplyTimeoutMs ?? DEFAULT_ADMIN_REPLY_TIMEOUT_MS;
    this.onClientDisconnected = () => {
      if (!this.stopping) this.scheduleReconnect();
    };
  }

  /**
   * Wrap an idempotent device call in bounded retry + exp backoff (clock-driven).
   * **Use only for idempotent operations** — reads, `set-*` config, `set_channel`,
   * `login`/`getStatus`/`getTelemetry`. Don't wrap `sendTextMessage`, `reboot`,
   * `sendAdvert` — those non-idempotent ops surface failures cleanly; the
   * reconnect daemon below brings the link back across a node reboot or WiFi blip.
   */
  private request<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      clock: this.clock,
      onRetry: ({ attempt, delayMs, error }) => {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `meshcore-mcp: device retry (attempt ${attempt + 1} after ${delayMs}ms): ${msg}\n`,
        );
      },
    });
  }

  /**
   * Schedule a reconnect attempt after exp backoff (capped). Re-entrant-safe via
   * `reconnectScheduled`. Stops scheduling new attempts once {@link stop} runs.
   */
  private scheduleReconnect(): void {
    if (this.reconnectScheduled || this.stopping) return;
    this.reconnectScheduled = true;
    const delayMs = Math.min(2000, 200 * 2 ** this.reconnectAttempt);
    this.clock.setTimeout(() => {
      this.reconnectScheduled = false;
      void this.attemptReconnect();
    }, delayMs);
  }

  /** One reconnect attempt; on failure, reschedule with growing backoff. */
  private async attemptReconnect(): Promise<void> {
    if (this.stopping) return;
    this.reconnectAttempt += 1;
    process.stderr.write(
      `meshcore-mcp: device disconnected; reconnect attempt ${this.reconnectAttempt}…\n`,
    );
    try {
      await this.client.connect();
      this.reconnectAttempt = 0;
      process.stderr.write("meshcore-mcp: device reconnected.\n");
    } catch (e) {
      process.stderr.write(
        `meshcore-mcp: reconnect failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Connect the client, subscribe to its live events, and begin feeding the
   * traffic buffer. Idempotent: a second call while started is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.subscribe();
    // Hook the auto-reconnect daemon onto the client's lifecycle. On
    // `disconnected` (node reboot, WiFi blip), schedule reconnect with backoff;
    // idempotent reads bridge over via the retry path.
    this.client.on("disconnected", this.onClientDisconnected);
    this.started = true;
    await this.client.connect();
  }

  /**
   * Unsubscribe from the client's events and close the connection. Safe to call
   * when not started.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    this.client.off("disconnected", this.onClientDisconnected);
    this.unsubscribe();
    this.started = false;
    await this.client.close();
  }

  /**
   * Recent live traffic, oldest→newest. With `since`, only events stamped at or
   * after that (injected-clock) time; otherwise the full retained window.
   */
  recentTraffic(since?: number): TrafficEvent[] {
    return since === undefined ? this.buffer.recent() : this.buffer.since(since);
  }

  /**
   * Register a callback fired synchronously whenever a new {@link TrafficEvent}
   * is buffered — the bridge the subscribable `meshcore://traffic/live` resource
   * (M4) uses to emit `notifications/resources/updated`. The buffer supports a
   * single hook; pass `undefined` to clear it. Keeping this on `MeshService`
   * preserves the rule that resources go through the service, never the buffer
   * or client directly.
   */
  onTraffic(cb: ((event: TrafficEvent) => void) | undefined): void {
    this.buffer.onPush(cb);
  }

  /**
   * The device's contact list — the roster behind the `meshcore://contacts`
   * resource (M4). Returns the typed {@link Contact} models verbatim from the
   * client; resources never call the client directly.
   */
  async contacts(): Promise<Contact[]> {
    return this.request(() => this.client.getContacts());
  }

  /**
   * The current injected-clock time, in ms. The sole "now" the tool layer uses
   * for relative-time digests — never `Date.now()` (PRD §6).
   */
  now(): number {
    return this.clock.now();
  }

  /**
   * A consolidated health snapshot for one node, hiding the home-vs-remote
   * distinction and the remote login (PRD §4).
   *
   * With no `node` (or a `node` that resolves to the connected device) it
   * assembles the **home** snapshot from the structured companion-protocol
   * reads. Otherwise it resolves the contact, logs in (with the injected
   * credentials, default guest), and reads the **remote** repeater's status and
   * telemetry.
   *
   * An unreachable target makes the login/status reads reject with a
   * `MeshCoreError`/timeout; that is allowed to throw here — the tool layer
   * catches it and formats an actionable error result.
   *
   * @param node - A contact name or hex public-key prefix. Omitted ⇒ home.
   */
  async nodeHealth(node?: string): Promise<NodeHealth> {
    const self = await this.request(() => this.client.getSelfInfo());

    if (node === undefined || this.isHome(node, self)) {
      return this.homeHealth(self);
    }

    const contact = await this.resolveContact(node);
    if (contact === undefined) {
      // No such contact — treat it like the home node's own identity match, or
      // fall through to a remote attempt by key only if it looks like hex. A
      // plain unknown name has nothing to log in to, so surface it as an error
      // the tool layer formats (a MeshCoreError keeps the error path uniform).
      throw new MeshServiceUnknownNodeError(node);
    }

    // The home node may itself be listed as a contact; if the resolved contact
    // is the connected device, return the richer home snapshot.
    if (contact.publicKey === self.publicKey) {
      return this.homeHealth(self);
    }

    return this.remoteHealth(node, contact);
  }

  /**
   * One consolidated roster: the home node plus every known contact, each with
   * its last-heard time, role, and public key. Backs `survey_mesh`.
   */
  async surveyMesh(): Promise<MeshSurvey> {
    const [self, contacts] = await Promise.all([
      this.request(() => this.client.getSelfInfo()),
      this.request(() => this.client.getContacts()),
    ]);

    const roster: SurveyContact[] = contacts
      .map((c) => ({
        name: c.advName,
        publicKey: c.publicKey,
        role: c.type,
        lastHeardMs: c.lastAdvert.getTime(),
      }))
      // Signal-first: most-recently-heard contacts at the top.
      .sort((a, b) => b.lastHeardMs - a.lastHeardMs);

    return {
      home: { name: self.name, publicKey: self.publicKey, role: self.type },
      contacts: roster,
    };
  }

  /**
   * Candidate node identifiers — the home node plus every contact name — for
   * argument completion (the prompt `node` args and the `meshcore://node/{node}`
   * resource template). Deduped; empty names dropped.
   */
  async nodeNames(): Promise<string[]> {
    const survey = await this.surveyMesh();
    const names = [survey.home.name, ...survey.contacts.map((c) => c.name)];
    return [...new Set(names.filter((n) => n.length > 0))];
  }

  /** The device's configured channels (slot index, name, hex secret). */
  async channels(): Promise<Channel[]> {
    return this.request(() => this.client.getChannels());
  }

  /**
   * Add or overwrite a channel slot. With no `secret`, generates a random
   * 16-byte key (a private "random" channel); with no `index`, uses the next
   * free slot (so a plain add never clobbers an existing channel). Returns the
   * resulting channel including its secret (hex), so the key can be shared.
   */
  async setChannel(opts: {
    name: string;
    secret?: string;
    index?: number;
  }): Promise<{ index: number; name: string; secret: string }> {
    const secret = opts.secret ?? randomBytes(16).toString("hex");
    const index = opts.index ?? (await this.nextFreeChannelIndex());
    await this.request(() => this.client.setChannel(index, opts.name, secret));
    return { index, name: opts.name, secret };
  }

  /**
   * Delete a channel slot, by `index` or by `name` (resolved to its slot).
   * Idempotent (an emptied slot stays empty), so it routes through the retry
   * path; the tool marks it destructive.
   */
  async deleteChannel(opts: { index?: number; name?: string }): Promise<{ index: number; name?: string }> {
    let index = opts.index;
    let name = opts.name;
    if (index === undefined) {
      if (name === undefined) {
        throw new MeshCoreError("delete_channel needs an `index` or a `name`");
      }
      const match = await this.request(() => this.client.findChannelByName(name as string));
      if (match === undefined) throw await this.unknownChannelError(`#${name}`);
      index = match.channelIdx;
      name = match.name;
    }
    const slot = index;
    await this.request(() => this.client.deleteChannel(slot));
    return name === undefined ? { index: slot } : { index: slot, name };
  }

  /**
   * Trace a route through the mesh: send a trace packet along an explicit `path`
   * of repeater hops (or a contact's known out-path) and report each hop's SNR
   * when the round-trip completes — a precise propagation/coverage probe.
   *
   * Not retry-wrapped: a trace transmits a probe and carries its own device-side
   * timeout, and a timeout here is a *result* ("the path didn't respond"), not a
   * transient glitch to retry.
   */
  async tracePath(opts: { path?: string; node?: string }): Promise<TraceResult> {
    let pathBytes: Uint8Array;
    if (opts.path !== undefined && opts.path !== "") {
      pathBytes = parseTracePath(opts.path);
    } else if (opts.node !== undefined) {
      const contact = await this.resolveContact(opts.node);
      if (contact === undefined) throw new MeshServiceUnknownNodeError(opts.node);
      if (contact.outPathLen <= 0 || contact.outPath === "") {
        throw new MeshCoreError(
          `"${contact.advName || opts.node}" has no known multi-hop path (a direct or unknown route) — provide an explicit \`path\``,
        );
      }
      pathBytes = fromHex(contact.outPath);
    } else {
      throw new MeshCoreError('trace_path needs a `path` (e.g. "23,5f,3a") or a `node`');
    }
    return toTraceResult(await this.client.tracePath(pathBytes));
  }

  /**
   * The next free channel slot. The device returns every slot (configured or
   * not) with empty-named ones free, so prefer the first empty-named slot;
   * fall back to one past the highest index when none is empty.
   */
  private async nextFreeChannelIndex(): Promise<number> {
    const channels = await this.request(() => this.client.getChannels());
    const empty = channels.find((c) => c.name === "");
    if (empty !== undefined) return empty.channelIdx;
    return channels.reduce((max, c) => Math.max(max, c.channelIdx), -1) + 1;
  }

  /**
   * Send a text message, resolving `target` as either a **contact** or a
   * **channel** and routing to the matching typed client method (PRD §5.1).
   *
   * Resolution order:
   * - `#name` or `#idx` — an explicit channel reference (the `#` is stripped);
   * - a bare integer (e.g. `"0"`) — a channel index;
   * - otherwise a contact by name, then by hex public-key prefix;
   * - failing all of those, a channel by name (a last resort for names that did
   *   not match a contact).
   *
   * Returns a small structured digest of what was sent and to whom/which
   * channel — not the raw `SentResult`. An unknown target throws a
   * {@link MeshServiceUnknownNodeError}, which the tool layer formats.
   */
  async sendMessage(target: string, text: string, confirm = false): Promise<SendMessageResult> {
    const result = await this.transmit(target, text, confirm);
    // H4: record our own send so it surfaces in recent traffic / the live stream.
    this.recordSent(result);
    return result;
  }

  /** Resolve `target` and transmit; returns the structured result (no recording). */
  private async transmit(target: string, text: string, confirm: boolean): Promise<SendMessageResult> {
    // An explicit channel reference: `#name` or `#idx`.
    if (target.startsWith("#")) {
      const ref = target.slice(1);
      const channel = await this.resolveChannel(ref);
      if (channel === undefined) {
        throw await this.unknownChannelError(target);
      }
      await this.client.sendChannelTextMessage(channel.channelIdx, text);
      return {
        kind: "channel",
        channelIdx: channel.channelIdx,
        channelName: channel.name,
        text,
      };
    }

    // A bare integer is a channel index.
    if (/^\d+$/.test(target)) {
      const idx = Number(target);
      const channel = await this.resolveChannelByIndex(idx);
      await this.client.sendChannelTextMessage(idx, text);
      return {
        kind: "channel",
        channelIdx: idx,
        channelName: channel?.name,
        text,
      };
    }

    // Otherwise a contact by name or hex prefix.
    const contact = await this.resolveContact(target);
    if (contact !== undefined) {
      const ack = await this.sendContact(contact, text, confirm);
      return {
        kind: "contact",
        contact: contact.advName || target,
        publicKey: contact.publicKey,
        text,
        ...ack,
      };
    }

    // Last resort: a channel matched by name (no `#` prefix).
    const channel = await this.resolveChannel(target);
    if (channel !== undefined) {
      await this.client.sendChannelTextMessage(channel.channelIdx, text);
      return {
        kind: "channel",
        channelIdx: channel.channelIdx,
        channelName: channel.name,
        text,
      };
    }

    throw new MeshServiceUnknownNodeError(target);
  }

  /**
   * Run one enumerated `admin` command against `node` (execution plan §9, §6).
   *
   * Validates `command` against {@link ADMIN_COMMANDS} and `params` against the
   * command's Zod schema first — a bad command or params throws an
   * {@link AdminCommandError} before any device contact. Then:
   *
   * - **`dryRun`** — return the synthesized {@link AdminCommandDef.preview},
   *   touching nothing.
   * - **home node + a `home()` path** — dispatch the structured
   *   {@link MeshCoreClient} method.
   * - **remote node (or a `remote-only` command)** — resolve the contact,
   *   `login` (with the injected credentials, default guest), send each CLI
   *   string as `CliData`, and await the repeater's reply (the next
   *   `contactMessage` from that node, correlated by sender + timing, timed out
   *   on the injected clock). No explicit logout (none exists — §6).
   *
   * A `remote-only` command targeting the home node throws an
   * {@link AdminCommandError}. An unreachable/unknown remote rejects at `login`
   * (a `MeshCoreError`), which propagates for the tool layer to format.
   */
  async runAdmin(
    node: string,
    command: string,
    params: unknown,
    dryRun: boolean,
  ): Promise<AdminResult> {
    const def = ADMIN_COMMANDS[command];
    if (def === undefined) {
      const known = Object.keys(ADMIN_COMMANDS).join(", ");
      throw new AdminCommandError(
        `Unknown admin command "${command}". Known commands: ${known}.`,
      );
    }

    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(params)"}: ${i.message}`)
        .join("; ");
      throw new AdminCommandError(`Invalid params for "${command}": ${issues}.`);
    }
    const p = parsed.data;

    if (dryRun) {
      return {
        command,
        tier: def.tier,
        dryRun: true,
        preview: def.preview(node, p),
      };
    }

    const self = await this.request(() => this.client.getSelfInfo());
    const isHome = this.isHome(node, self);

    // Home dispatch: only when the node is home, the command is home-reachable,
    // and a structured path exists.
    if (isHome) {
      if (def.scope === "remote-only" || def.home === undefined) {
        throw new AdminCommandError(
          `Command "${command}" is remote-only and cannot run against the home node "${node}".`,
        );
      }
      await def.home(this.client, node, p);
      return { command, tier: def.tier, dryRun: false, via: "home" };
    }

    // Remote dispatch: login → CliData → await reply.
    return this.runAdminRemote(node, def, p);
  }

  // --- internals ---------------------------------------------------------

  /**
   * The remote admin handshake (§6): resolve the contact, `login` (guest by
   * default, or the injected credential), send each CLI string as a `CliData`
   * text message, then await the repeater's reply — the next `contactMessage`
   * from that node's `pubKeyPrefix`, correlated by sender + timing. There is no
   * explicit logout (none exists; sessions expire server-side). The captured
   * reply is also recorded by the traffic buffer — expected.
   */
  private async runAdminRemote(
    node: string,
    def: AdminCommandDef,
    params: unknown,
  ): Promise<AdminResult> {
    const contact = await this.resolveContact(node);
    if (contact === undefined) {
      // Nothing to log in to — surface it the same way an unreachable node is.
      throw new MeshServiceUnknownNodeError(node);
    }

    const password = this.credentials?.(node) ?? "";
    const { pubKeyPrefix } = await this.request(() => this.client.login(contact, password));

    const cli = def.remoteCli(params);
    const lines = Array.isArray(cli) ? cli : [cli];

    // Arm the reply listener *before* sending, so a fast reply cannot race past
    // it. The reply correlates by sender prefix + timing (§6); long output may
    // span multiple messages, but the first reply is the structured result.
    const replyPromise = this.awaitContactReply(pubKeyPrefix, this.adminReplyTimeoutMs);
    for (const line of lines) {
      await this.client.sendTextMessage(contact, line, TxtType.CliData);
    }
    const reply = await replyPromise;

    return { command: def.name, tier: def.tier, dryRun: false, via: "remote", reply };
  }

  /**
   * Await the next `contactMessage` from `pubKeyPrefix`, resolving with its
   * text, or rejecting on a {@link Clock}-scheduled timeout. Both paths clean up
   * the listener and the timer exactly once — no native timers (PRD §6).
   *
   * The reply is correlated by **sender + timing** (§6): the first
   * `contactMessage` whose `pubKeyPrefix` matches the logged-in node. The
   * captured message is also recorded by the traffic buffer (the service's own
   * subscription) — that is expected.
   */
  /**
   * Send a direct (contact) message and, when `confirm`, wait for its delivery
   * ack — reporting the route and round-trip. The ack listener is **armed before
   * the send** and matched by `expectedAckCrc`, so a fast ack (the sim emits one
   * on the next microtask; real hardware ~hundreds of ms later) is never raced
   * past. A missing ack within the window is `delivered: false`, not an error.
   */
  private async sendContact(
    contact: Contact,
    text: string,
    confirm: boolean,
  ): Promise<{ route: "direct" | "flood"; delivered?: boolean; roundTripMs?: number }> {
    if (!confirm) {
      const sent = await this.client.sendTextMessage(contact, text);
      return { route: sent.result === 1 ? "flood" : "direct" };
    }

    const acks: SendConfirmed[] = [];
    let want: number | undefined;
    let resolveRt: ((rt: number | null) => void) | undefined;
    const onAck = (p: SendConfirmed): void => {
      acks.push(p);
      if (want !== undefined && p.ackCode === want) resolveRt?.(p.roundTrip);
    };
    this.client.on("sendConfirmed", onAck);
    let timer: TimerHandle | undefined;
    try {
      const sent = await this.client.sendTextMessage(contact, text);
      const route: "direct" | "flood" = sent.result === 1 ? "flood" : "direct";
      want = sent.expectedAckCrc;
      const already = acks.find((p) => p.ackCode === want);
      if (already) return { route, delivered: true, roundTripMs: already.roundTrip };
      const timeoutMs = Math.min((sent.estTimeout || 4000) + 2000, 30_000);
      const rt = await new Promise<number | null>((resolve) => {
        resolveRt = resolve;
        timer = this.clock.setTimeout(() => resolve(null), timeoutMs);
      });
      return rt === null ? { route, delivered: false } : { route, delivered: true, roundTripMs: rt };
    } finally {
      this.client.off("sendConfirmed", onAck);
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
  }

  private awaitContactReply(pubKeyPrefix: string, timeoutMs: number): Promise<string> {
    const want = pubKeyPrefix.toLowerCase();
    return new Promise<string>((resolve, reject) => {
      let timer: TimerHandle | undefined;
      const onMessage = (m: ContactMessage): void => {
        if (m.pubKeyPrefix.toLowerCase() !== want) return;
        cleanup();
        resolve(m.text);
      };
      const cleanup = (): void => {
        this.client.off("contactMessage", onMessage);
        if (timer !== undefined) this.clock.clearTimeout(timer);
      };
      this.client.on("contactMessage", onMessage);
      timer = this.clock.setTimeout(() => {
        cleanup();
        reject(
          new MeshCoreError(
            `no reply from ${pubKeyPrefix} within ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
    });
  }

  /**
   * Resolve a channel by index or name (a `#`-stripped ref). A purely numeric
   * ref is an index; otherwise it is matched by name. Returns `undefined` when
   * neither matches.
   */
  private async resolveChannel(ref: string): Promise<Channel | undefined> {
    if (/^\d+$/.test(ref)) {
      return this.resolveChannelByIndex(Number(ref));
    }
    return this.request(() => this.client.findChannelByName(ref));
  }

  /**
   * Build a channel-aware "not found" error (H6): a `#`-target is unambiguously
   * a channel, so don't report a contact miss — say so and list the known
   * channels to choose from.
   */
  private async unknownChannelError(target: string): Promise<MeshCoreError> {
    const known = (await this.channels().catch(() => []))
      .filter((c) => c.name !== "")
      .map((c) => `#${c.name}`);
    const hint = known.length > 0 ? ` Known channels: ${known.join(", ")}.` : "";
    return new MeshServiceUnknownChannelError(target, hint);
  }

  /**
   * Resolve a channel by its numeric index, returning `undefined` if the device
   * reports no such slot (a failed read is swallowed — the send itself still
   * goes out by index, the lookup is only to enrich the result digest).
   */
  private async resolveChannelByIndex(idx: number): Promise<Channel | undefined> {
    try {
      return await this.client.getChannel(idx);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether `node` refers to the connected home device — by its advertised
   * name or by a hex prefix of its public key. Used to route a named/keyed
   * `nodeHealth` request to the home snapshot rather than a remote login.
   */
  private isHome(node: string, self: SelfInfo): boolean {
    if (node === self.name) return true;
    const ref = node.toLowerCase();
    return /^[0-9a-f]+$/.test(ref) && self.publicKey.startsWith(ref);
  }

  /**
   * Resolve a contact by advertised name, then (failing that) by hex
   * public-key prefix. Returns `undefined` when neither matches.
   */
  private async resolveContact(node: string): Promise<Contact | undefined> {
    const byName = await this.request(() => this.client.findContactByName(node));
    if (byName !== undefined) return byName;
    if (/^[0-9a-f]+$/i.test(node)) {
      return this.request(() => this.client.findContactByPublicKeyPrefix(node.toLowerCase()));
    }
    return undefined;
  }

  /**
   * Assemble the **home** snapshot from the structured companion-protocol
   * reads: identity + radio config (`getSelfInfo`), battery, device time, and
   * the three stat groups. Stat reads are gathered together; a missing field
   * stays absent rather than synthesized.
   */
  private async homeHealth(self: SelfInfo): Promise<NodeHealth> {
    // Gather sub-results independently with bounded retry. A single sub-call
    // timeout no longer fails the whole snapshot — we degrade gracefully and
    // list what we couldn't read in `degraded` (PRD §4 "every result is
    // digested; every error is actionable").
    const [batteryR, deviceTimeR, coreR, radioR, packetsR] = await Promise.allSettled([
      this.request(() => this.client.getBatteryVoltage()),
      this.request(() => this.client.getDeviceTime()),
      this.request(() => this.client.getStatsCore()),
      this.request(() => this.client.getStatsRadio()),
      this.request(() => this.client.getStatsPackets()),
    ]);

    const degraded: string[] = [];
    const battery = batteryR.status === "fulfilled" ? batteryR.value : (degraded.push("battery"), undefined);
    const deviceTime = deviceTimeR.status === "fulfilled" ? deviceTimeR.value : (degraded.push("deviceTime"), undefined);
    const core = coreR.status === "fulfilled" ? coreR.value : (degraded.push("statsCore"), undefined);
    const radioStats = radioR.status === "fulfilled" ? radioR.value : (degraded.push("statsRadio"), undefined);
    const packets = packetsR.status === "fulfilled" ? packetsR.value : (degraded.push("statsPackets"), undefined);

    const stats: NonNullable<NodeHealth["stats"]> = {};
    let uptimeSecs: number | undefined;
    let txQueueLen: number | undefined;
    let batteryMilliVolts: number | undefined = battery?.milliVolts;

    if (core?.type === "core") {
      uptimeSecs = core.uptimeSecs;
      txQueueLen = core.queueLen;
      if (core.batteryMilliVolts > 0) batteryMilliVolts = core.batteryMilliVolts;
    }
    if (radioStats?.type === "radio") {
      stats.noiseFloor = radioStats.noiseFloor;
      stats.lastRssi = radioStats.lastRssi;
      stats.lastSnr = radioStats.lastSnr;
    }
    if (packets?.type === "packets") {
      stats.packetsReceived = packets.recv;
      stats.packetsSent = packets.sent;
      stats.recvFlood = packets.recvFlood;
      stats.recvDirect = packets.recvDirect;
      stats.sentFlood = packets.sentFlood;
      stats.sentDirect = packets.sentDirect;
    }

    // getSelfInfo succeeded above, so the node IS reachable. `lastHeardMs` falls
    // back to "now" when the device clock is unavailable — we just spoke to it.
    const result: NodeHealth = {
      kind: "home",
      node: self.name,
      publicKey: self.publicKey,
      role: self.type,
      reachable: true,
      lastHeardMs: deviceTime?.getTime() ?? this.clock.now(),
      radio: {
        // Device wire units are kHz (freq) and Hz (bw); normalise to the
        // surface units MHz / kHz so read and write speak the same language.
        freqMhz: self.radioFreq / 1000,
        bwKhz: self.radioBw / 1000,
        sf: self.radioSf,
        cr: self.radioCr,
        txPower: self.txPower,
        maxTxPower: self.maxTxPower,
      },
    };
    if (deviceTime !== undefined) result.deviceTimeMs = deviceTime.getTime();
    if (batteryMilliVolts !== undefined) {
      result.battery = { milliVolts: batteryMilliVolts, volts: batteryMilliVolts / 1000 };
    }
    if (uptimeSecs !== undefined) result.uptimeSecs = uptimeSecs;
    if (txQueueLen !== undefined) result.txQueueLen = txQueueLen;
    if (Object.keys(stats).length > 0) result.stats = stats;
    if (degraded.length > 0) result.degraded = degraded;
    return result;
  }

  /**
   * Assemble a **remote** snapshot: log in (guest by default, or the injected
   * credential), then read the repeater's status and telemetry. Login/status
   * reject for an unreachable node — that rejection propagates to the caller.
   * Telemetry is reported only as an opaque byte length (PRD §4).
   */
  private async remoteHealth(node: string, contact: Contact): Promise<NodeHealth> {
    const password = this.credentials?.(node) ?? "";
    await this.request(() => this.client.login(contact, password));
    const status = await this.request(() => this.client.getStatus(contact));

    // Telemetry is best-effort: a node may report none. A failure here must not
    // sink an otherwise-good status snapshot, so swallow it to undefined.
    let telemetryBytes: number | undefined;
    try {
      const telemetry = await this.request(() => this.client.getTelemetry(contact));
      telemetryBytes = telemetry.lppSensorData.length;
    } catch {
      telemetryBytes = undefined;
    }

    return {
      kind: "remote",
      node: contact.advName || node,
      publicKey: contact.publicKey,
      role: contact.type,
      reachable: true,
      lastHeardMs: contact.lastAdvert.getTime(),
      battery: { milliVolts: status.batteryMilliVolts, volts: status.batteryMilliVolts / 1000 },
      uptimeSecs: status.totalUpTimeSecs,
      txQueueLen: status.currTxQueueLen,
      stats: {
        packetsReceived: status.packetsReceived,
        packetsSent: status.packetsSent,
        recvFlood: status.recvFlood,
        recvDirect: status.recvDirect,
        sentFlood: status.sentFlood,
        sentDirect: status.sentDirect,
        noiseFloor: status.noiseFloor,
        lastRssi: status.lastRssi,
        lastSnr: status.lastSnr,
        totalAirTimeSecs: status.totalAirTimeSecs,
        errEvents: status.errEvents,
      },
      telemetryBytes,
    };
  }

  /**
   * Wire one listener per source event, each mapping into a {@link TrafficEvent}
   * and pushing it to the buffer. Listeners are recorded so {@link unsubscribe}
   * can detach exactly these references.
   */
  private subscribe(): void {
    this.listen("contactMessage", (m) =>
      this.record("contact", true, { sender: m.pubKeyPrefix, text: m.text }),
    );
    this.listen("channelMessage", (m) =>
      this.record("channel", true, { channelIdx: m.channelIdx, text: m.text }),
    );
    this.listen("channelData", (d) =>
      this.record("channelData", false, { channelIdx: d.channelIdx, snr: d.snr }),
    );
    this.listen("advert", (a) =>
      this.record("advert", false, { sender: a.publicKey }),
    );
    this.listen("newAdvert", (a) =>
      this.record("advert", false, { sender: a.publicKey }),
    );
    this.listen("rawData", (d) =>
      this.record("raw", false, { rssi: d.lastRssi, snr: d.lastSnr }),
    );
    this.listen("logRxData", (d) =>
      this.record("raw", false, { rssi: d.lastRssi, snr: d.lastSnr }),
    );
  }

  /**
   * Register a typed listener on the client and remember it for teardown. The
   * stored reference is the exact function passed to `client.on`, so
   * `client.off` removes precisely it. The event name narrows the listener's
   * argument tuple via the client's typed event map.
   */
  private listen<E extends keyof MeshCoreEvents & string>(
    event: E,
    fn: (...args: MeshCoreEvents[E]) => void,
  ): void {
    this.client.on(event, fn);
    this.listeners.push({ event, fn: fn as (...args: never[]) => void });
  }

  /** Detach every listener registered by {@link subscribe}. */
  private unsubscribe(): void {
    for (const { event, fn } of this.listeners) {
      // `event` and `fn` were registered together with matching types; the
      // erased tuple type prevents TS re-correlating them here, so detach via
      // a single concrete-but-erased overload.
      (
        this.client.off as unknown as (
          e: string,
          f: (...args: never[]) => void,
        ) => void
      )(event, fn);
    }
    this.listeners.length = 0;
  }

  /**
   * Build a {@link TrafficEvent} — server id + injected-clock stamp + structural
   * provenance — and push it to the buffer. `fields` carries only the
   * event-specific provenance for this `kind`; absent fields stay absent.
   */
  private record(
    kind: TrafficKind,
    decryptVerified: boolean,
    fields: Pick<
      TrafficEvent,
      "sender" | "channelIdx" | "text" | "rssi" | "snr"
    >,
    direction: "in" | "out" = "in",
  ): void {
    const event: TrafficEvent = {
      id: `evt-${this.nextEventSeq++}`,
      at: this.clock.now(),
      kind,
      decryptVerified,
      direction,
      ...fields,
    };
    this.buffer.push(event);
  }

  /**
   * Record a message **we** sent into the traffic buffer (H4). The device
   * exposes no sent-message history, so this is our own session record — it
   * makes outbound traffic visible in `get_recent_traffic` and the live stream
   * (it cannot show sends made from *other* clients). Our own plaintext is
   * trivially "decrypt-verified".
   */
  private recordSent(result: SendMessageResult): void {
    this.record(
      result.kind,
      true,
      { sender: result.publicKey, channelIdx: result.channelIdx, text: result.text },
      "out",
    );
  }
}
