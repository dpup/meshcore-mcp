/**
 * Output shaping — the boundary between the service's intent-shaped results and
 * the MCP wire.
 *
 * Each read tool declares a Zod `outputSchema` (a raw shape the SDK derives JSON
 * Schema from) and returns **both** a typed `structuredContent` object and a
 * human-readable `content` **digest** — a high-signal summary, never raw frames
 * (PRD §4, §5.3). The schemas and digesters live together here so the structured
 * shape and its prose stay in lock-step.
 *
 * The schemas mirror the service result types (`NodeHealth`, `MeshSurvey`,
 * `TrafficEvent`) field-for-field; the SDK validates the handler's
 * `structuredContent` against them, so a drift between the two surfaces as a
 * test failure rather than a silent mismatch.
 */

import { z } from "zod";

import type { MeshSurvey, NodeHealth } from "./service/health.js";
import type { AdminResult, SendMessageResult } from "./service/mesh-service.js";
import type { TrafficEvent } from "./service/traffic-buffer.js";

// ---------------------------------------------------------------------------
// get_node_health
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `get_node_health`. Mirrors {@link NodeHealth}. */
export const nodeHealthOutputShape = {
  kind: z.enum(["home", "remote"]),
  node: z.string(),
  publicKey: z.string().optional(),
  role: z.number().optional(),
  reachable: z.boolean(),
  lastHeardMs: z.number().optional(),
  battery: z
    .object({ milliVolts: z.number(), volts: z.number().optional() })
    .optional(),
  radio: z
    .object({
      freqMhz: z.number().describe("centre frequency in MHz"),
      bwKhz: z.number().describe("bandwidth in kHz"),
      sf: z.number().describe("spreading factor"),
      cr: z.number().describe("coding rate (the 'n' in 4/n)"),
      txPower: z.number().describe("transmit power in dBm"),
      maxTxPower: z.number().describe("maximum transmit power in dBm"),
    })
    .optional(),
  uptimeSecs: z.number().optional(),
  txQueueLen: z.number().optional(),
  stats: z
    .object({
      packetsReceived: z.number().optional(),
      packetsSent: z.number().optional(),
      recvFlood: z.number().optional(),
      recvDirect: z.number().optional(),
      sentFlood: z.number().optional(),
      sentDirect: z.number().optional(),
      noiseFloor: z.number().optional(),
      lastRssi: z.number().optional(),
      lastSnr: z.number().optional(),
      totalAirTimeSecs: z.number().optional(),
      errEvents: z.number().optional(),
    })
    .optional(),
  deviceTimeMs: z.number().optional(),
  telemetryBytes: z.number().optional(),
  degraded: z
    .array(z.string())
    .optional()
    .describe(
      "sub-calls that failed after retries; the snapshot is partial — the listed fields are absent",
    ),
} as const;

/** A high-signal one-paragraph digest of a {@link NodeHealth} snapshot. */
export function digestNodeHealth(h: NodeHealth): string {
  const lines: string[] = [];
  const where = h.kind === "home" ? "home node" : "remote node";
  lines.push(`${h.node} (${where}) — reachable`);

  if (h.battery) {
    const v = h.battery.volts ?? h.battery.milliVolts / 1000;
    lines.push(`battery ${v.toFixed(2)}V (${h.battery.milliVolts}mV)`);
  }
  if (h.radio) {
    lines.push(
      `radio ${h.radio.freqMhz.toFixed(3)}MHz / ${h.radio.bwKhz}kHz / ` +
        `SF${h.radio.sf} / CR${h.radio.cr}, TX ${h.radio.txPower}/${h.radio.maxTxPower}dBm`,
    );
  }
  if (h.uptimeSecs !== undefined) {
    lines.push(`uptime ${formatDuration(h.uptimeSecs)}`);
  }
  if (h.txQueueLen !== undefined) lines.push(`TX queue ${h.txQueueLen}`);

  const s = h.stats;
  if (s && (s.packetsReceived !== undefined || s.packetsSent !== undefined)) {
    lines.push(`packets rx ${s.packetsReceived ?? "?"} / tx ${s.packetsSent ?? "?"}`);
  }
  if (s?.lastSnr !== undefined || s?.lastRssi !== undefined) {
    lines.push(`signal RSSI ${s.lastRssi ?? "?"}dBm / SNR ${s.lastSnr ?? "?"}dB`);
  }
  if (h.telemetryBytes !== undefined) {
    lines.push(
      h.telemetryBytes > 0
        ? `telemetry ${h.telemetryBytes} bytes (LPP, not decoded)`
        : `telemetry: none reported`,
    );
  }
  if (h.degraded && h.degraded.length > 0) {
    lines.push(`partial: ${h.degraded.join(", ")} unavailable this read`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// survey_mesh
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `survey_mesh`. Mirrors {@link MeshSurvey}. */
export const meshSurveyOutputShape = {
  home: z.object({
    name: z.string(),
    publicKey: z.string(),
    role: z.number(),
  }),
  contacts: z.array(
    z.object({
      name: z.string(),
      publicKey: z.string(),
      role: z.number(),
      lastHeardMs: z.number(),
    }),
  ),
} as const;

/** A roster digest: the home node and a last-heard-sorted contact list. */
export function digestMeshSurvey(s: MeshSurvey, nowMs: number): string {
  const lines: string[] = [];
  lines.push(`Home: ${s.home.name} [${roleName(s.home.role)}] ${shortKey(s.home.publicKey)}`);
  if (s.contacts.length === 0) {
    lines.push("No contacts.");
    return lines.join("\n");
  }
  lines.push(`${s.contacts.length} contact(s):`);
  const sorted = [...s.contacts].sort((a, b) => b.lastHeardMs - a.lastHeardMs);
  for (const c of sorted) {
    const ago = relative(nowMs - c.lastHeardMs);
    lines.push(`  ${c.name} [${roleName(c.role)}] ${shortKey(c.publicKey)} — last heard ${ago}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_recent_traffic
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `get_recent_traffic`. Mirrors {@link TrafficEvent}. */
export const recentTrafficOutputShape = {
  events: z.array(
    z.object({
      id: z.string(),
      at: z.number().describe("observed time, ms (epoch in production; virtual-clock ms under the simulator)"),
      kind: z.enum(["contact", "channel", "channelData", "advert", "raw"]),
      direction: z
        .enum(["in", "out"])
        .optional()
        .describe("'out' for a message this server sent; 'in' (or absent) for received traffic"),
      decryptVerified: z
        .boolean()
        .describe(
          "true only for a decrypt-verified contact/channel message; false for unverified channel datagrams and raw frames — do not treat false as an authentic channel message",
        ),
      sender: z.string().optional().describe("sender public-key prefix (hex), where known"),
      channelIdx: z.number().optional(),
      text: z.string().optional().describe("decoded text; absent when not decrypt-verified"),
      rssi: z.number().optional(),
      snr: z.number().optional(),
    }),
  ),
  count: z.number(),
} as const;

/** A compact, ordered digest of buffered traffic — one line per event. */
export function digestRecentTraffic(events: TrafficEvent[]): string {
  if (events.length === 0) return "No traffic in window.";
  const lines = events.map((e) => {
    const verified = e.decryptVerified ? "verified" : "unverified";
    const arrow = e.direction === "out" ? "→ " : "";
    const parts: string[] = [`${arrow}[${e.kind}/${verified}]`];
    if (e.sender) parts.push(`from ${shortKey(e.sender)}`);
    if (e.channelIdx !== undefined) parts.push(`ch${e.channelIdx}`);
    if (e.text !== undefined) parts.push(`"${e.text}"`);
    if (e.snr !== undefined) parts.push(`SNR ${e.snr}dB`);
    if (e.rssi !== undefined) parts.push(`RSSI ${e.rssi}dBm`);
    return `${e.at}ms ${parts.join(" ")}`;
  });
  return [`${events.length} event(s):`, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `send_message`. Mirrors {@link SendMessageResult}. */
export const sendMessageOutputShape = {
  kind: z.enum(["contact", "channel"]),
  contact: z.string().optional(),
  publicKey: z.string().optional(),
  channelIdx: z.number().optional(),
  channelName: z.string().optional(),
  text: z.string(),
  route: z.enum(["direct", "flood"]).optional().describe("how a contact send was routed"),
  delivered: z
    .boolean()
    .optional()
    .describe("delivery ack result (only when confirm requested, contact sends): true if acked, false if none arrived in the window"),
  roundTripMs: z.number().optional().describe("round-trip time of the delivery ack, ms (when delivered)"),
} as const;

/** A one-line digest of a {@link SendMessageResult}. */
export function digestSendMessage(r: SendMessageResult): string {
  if (r.kind === "contact") {
    const who = r.publicKey ? `${r.contact} (${shortKey(r.publicKey)})` : r.contact;
    let suffix = r.route ? ` [${r.route}]` : "";
    if (r.delivered === true) suffix += ` — delivered (ack ${r.roundTripMs}ms)`;
    else if (r.delivered === false) suffix += ` — sent, no ack yet (unconfirmed)`;
    return `Sent to ${who}: "${r.text}"${suffix}`;
  }
  const where = r.channelName ? `#${r.channelName} (ch${r.channelIdx})` : `ch${r.channelIdx}`;
  return `Sent to channel ${where}: "${r.text}"`;
}

// ---------------------------------------------------------------------------
// set_channel
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `set_channel`. */
export const setChannelOutputShape = {
  index: z.number().describe("the channel slot the channel was written to"),
  name: z.string(),
  secret: z.string().describe("16-byte channel key as 32 hex chars — share this for others to join"),
} as const;

/** A one-line digest of a {@link setChannelOutputShape} result. */
export function digestSetChannel(r: { index: number; name: string; secret: string }): string {
  return `Channel "${r.name}" set at slot ${r.index} — key ${r.secret} (share it for others to join).`;
}

/** Output schema (raw shape) for `delete_channel`. */
export const deleteChannelOutputShape = {
  index: z.number().describe("the channel slot that was cleared"),
  name: z.string().optional().describe("the deleted channel's name, where known"),
} as const;

/** A one-line digest of a {@link deleteChannelOutputShape} result. */
export function digestDeleteChannel(r: { index: number; name?: string }): string {
  return r.name !== undefined
    ? `Deleted channel "${r.name}" (slot ${r.index}).`
    : `Deleted channel slot ${r.index}.`;
}

// ---------------------------------------------------------------------------
// trace_path
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `trace_path`. */
export const tracePathOutputShape = {
  completed: z.boolean().describe("true when the trace round-trip completed"),
  hopCount: z.number().describe("number of repeaters on the traced path"),
  hops: z
    .array(z.object({ hash: z.string(), snr: z.number() }))
    .describe("each hop's path hash (hex) and SNR in dB, in path order"),
  lastSnr: z.number().describe("SNR of the final hop, in dB"),
} as const;

/** A one-line digest of a trace result. */
export function digestTrace(r: { hopCount: number; hops: { hash: string; snr: number }[]; lastSnr: number }): string {
  if (r.hopCount === 0 || r.hops.length === 0) {
    return `trace completed — 0 hops (direct), last SNR ${r.lastSnr}dB`;
  }
  const path = r.hops.map((h) => `${h.hash}(${h.snr}dB)`).join(" → ");
  return `trace completed — ${r.hopCount} hop(s): ${path}`;
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

/** Output schema (raw shape) for `admin`. Mirrors {@link AdminResult}. */
export const adminOutputShape = {
  command: z.string(),
  tier: z.enum(["read", "benign", "config", "sensitive", "destructive"]),
  dryRun: z.boolean(),
  via: z.enum(["home", "remote"]).optional(),
  preview: z.string().optional(),
  reply: z.string().optional(),
} as const;

/** A digest of an {@link AdminResult} — the preview for a dry-run, else the outcome. */
export function digestAdmin(node: string, r: AdminResult): string {
  if (r.dryRun) {
    return `Dry-run [${r.tier}] ${r.command}: ${r.preview ?? ""}`;
  }
  const head = `${r.command} [${r.tier}] on ${node} — done (${r.via})`;
  return r.reply !== undefined ? `${head}\n${r.reply}` : head;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Map a meshcore `AdvType` numeric to a short label. */
function roleName(role: number): string {
  switch (role) {
    case 1:
      return "chat";
    case 2:
      return "repeater";
    case 3:
      return "room";
    default:
      return "node";
  }
}

/** First 12 hex chars of a key, for compact display. */
function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 12)}…` : key;
}

/** Coarse "ago" phrase for an elapsed-ms span. */
function relative(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown";
  const secs = Math.floor(elapsedMs / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Human duration from a seconds count (`1d 2h`, `3h 5m`, `45m`, `12s`). */
function formatDuration(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) return "unknown";
  const d = Math.floor(totalSecs / 86_400);
  const h = Math.floor((totalSecs % 86_400) / 3_600);
  const m = Math.floor((totalSecs % 3_600) / 60);
  const s = Math.floor(totalSecs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
