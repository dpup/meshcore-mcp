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
 *
 * This module is the **presentation layer**, and every interpretive / lossy
 * transform lives here — relative times, durations, role names, the survey
 * summary, and (see {@link batteryPresentation}) the 1S Li-ion battery charge
 * **%**. The dependency points format → service, never the reverse: the service
 * keeps raw, lossless intent (e.g. battery raw millivolts) so a second
 * `NodeHealth` consumer never inherits a chemistry opinion. Where an output
 * schema carries more than the intent type (battery `volts`/`percent`), a small
 * per-tool projection ({@link nodeHealthOutput}) adds those presentation fields;
 * other tools pass the service result through unchanged.
 */

import { z } from "zod";

import { formatDuration, formatRelative as relative, HOUR_MS } from "./time.js";
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
  // `volts`/`percent` are presentation-added: the service's `NodeHealth`
  // carries raw `milliVolts` only; `nodeHealthOutput` derives these (see
  // `batteryPresentation`). They are part of the wire contract, not the intent.
  battery: z
    .object({
      milliVolts: z.number(),
      volts: z.number().optional(),
      percent: z.number().optional().describe("approximate charge % (rough 1S Li-ion estimate)"),
    })
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

/**
 * Presentation-derived battery block: raw millivolts plus the interpretive,
 * lossy fields the service deliberately does not carry. `volts` is
 * `milliVolts / 1000`; `percent` is a rough linear 1S Li-ion charge estimate
 * (≈3.3 V empty … 4.2 V full, clamped 0–100), present **only** for a plausible
 * 2500–5000 mV reading — friendly, not exact; the discharge curve is nonlinear
 * and chemistry varies, which is exactly why this lives in the presentation
 * layer and not the device-facing service.
 */
export function batteryPresentation(milliVolts: number): {
  milliVolts: number;
  volts: number;
  percent?: number;
} {
  const battery: { milliVolts: number; volts: number; percent?: number } = {
    milliVolts,
    volts: milliVolts / 1000,
  };
  if (milliVolts >= 2500 && milliVolts <= 5000) {
    battery.percent = Math.max(0, Math.min(100, Math.round(((milliVolts - 3300) / 900) * 100)));
  }
  return battery;
}

/**
 * The presentation projection of a {@link NodeHealth} snapshot — the raw service
 * result with the interpretive battery fields (`volts`/`percent`) added. This is
 * what `get_node_health` ships as `structuredContent` (it validates against
 * {@link nodeHealthOutputShape}) and what {@link digestNodeHealth} renders, so
 * the structured wire and its prose derive from the same projected data.
 *
 * node-health is the one read with an interpretive derivation, so it gets a
 * per-tool projection; other tools pass the service result straight through.
 */
export type NodeHealthOutput = Omit<NodeHealth, "battery"> & {
  battery?: { milliVolts: number; volts: number; percent?: number };
};

/** Project a raw {@link NodeHealth} into its presentation output shape. */
export function nodeHealthOutput(raw: NodeHealth): NodeHealthOutput {
  const { battery, ...rest } = raw;
  return battery !== undefined
    ? { ...rest, battery: batteryPresentation(battery.milliVolts) }
    : { ...rest };
}

/** A high-signal one-paragraph digest of a {@link NodeHealthOutput} snapshot. */
export function digestNodeHealth(h: NodeHealthOutput): string {
  const lines: string[] = [];
  const where = h.kind === "home" ? "home node" : "remote node";
  lines.push(`${h.node} (${where}) — reachable`);

  if (h.battery) {
    const pct = h.battery.percent !== undefined ? ` (~${h.battery.percent}%)` : "";
    lines.push(`battery ${h.battery.volts.toFixed(2)}V${pct}`);
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

/**
 * The element schema of a contact roster — mirrors `SurveyContact`, the intent
 * projection of a meshcore-ts `Contact`. Shared by `survey_mesh`
 * ({@link meshSurveyOutputShape}) and the `meshcore://contacts` resource
 * ({@link contactsOutputShape}) so the two reads validate against one shape and
 * cannot drift (and neither leaks a raw `Contact` internal).
 */
const surveyContactSchema = z.object({
  name: z.string(),
  publicKey: z.string(),
  role: z.number(),
  lastHeardMs: z.number(),
});

/** Output schema (raw shape) for `survey_mesh`. Mirrors {@link MeshSurvey}. */
export const meshSurveyOutputShape = {
  home: z.object({
    name: z.string(),
    publicKey: z.string(),
    role: z.number(),
  }),
  contacts: z.array(surveyContactSchema),
} as const;

/**
 * Output schema (raw shape) for the `meshcore://contacts` resource. Mirrors the
 * `SurveyContact` projection {@link MeshService.contacts} returns; reuses the
 * same {@link surveyContactSchema} element as {@link meshSurveyOutputShape}.
 * This is the guard that pins the resource's public JSON to the intent shape —
 * a meshcore-ts `Contact` reshape can't silently change it.
 */
export const contactsOutputShape = {
  contacts: z.array(surveyContactSchema),
  count: z.number(),
} as const;

/** A roster digest: the home node and a last-heard-sorted contact list. */
export function digestMeshSurvey(s: MeshSurvey, nowMs: number): string {
  const lines: string[] = [];
  lines.push(`Home: ${s.home.name} [${roleName(s.home.role)}] ${shortKey(s.home.publicKey)}`);
  if (s.contacts.length === 0) {
    lines.push("No contacts.");
    return lines.join("\n");
  }
  // A one-line overview so a large roster is graspable at a glance. "Recent" is
  // a SYMMETRIC ~1h window: heard within the last hour, tolerating up to ~1h of
  // forward clock skew — so a contact hours into the future (a badly-skewed RTC)
  // is NOT miscounted as recent. This is independent of formatRelative's coarser
  // 2-day "just now vs unknown" skew threshold (a contact ~12h ahead still
  // renders per-row as "just now", it just doesn't inflate this count).
  const recent = s.contacts.filter((c) => {
    const e = nowMs - c.lastHeardMs;
    return e < HOUR_MS && e > -HOUR_MS;
  }).length;
  const repeaters = s.contacts.filter((c) => roleName(c.role) === "repeater").length;
  const rooms = s.contacts.filter((c) => roleName(c.role) === "room").length;
  const breakdown = [
    `${recent} heard in the last hour`,
    repeaters > 0 ? `${repeaters} repeaters` : "",
    rooms > 0 ? `${rooms} rooms` : "",
  ].filter(Boolean).join(", ");
  lines.push(`${s.contacts.length} contact(s) — ${breakdown}:`);
  // The service is the single owner of roster order: surveyMesh() already
  // returns contacts most-recently-heard-first, so iterate as-is (no re-sort).
  for (const c of s.contacts) {
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

/**
 * A compact, ordered digest of buffered traffic — one line per event. `nowMs`
 * (the injected-clock now) renders each event's time as a human "ago" phrase
 * instead of raw ms.
 */
export function digestRecentTraffic(events: TrafficEvent[], nowMs: number): string {
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
    return `${relative(nowMs - e.at).padEnd(9)} ${parts.join(" ")}`;
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
  confirmationNotApplicable: z
    .boolean()
    .optional()
    .describe(
      "true when confirm was requested for a channel/broadcast send: there is no single recipient to ack, so delivery confirmation does not apply (delivered/roundTripMs are correctly absent) — distinct from a fire-and-forget send",
    ),
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
  const note = r.confirmationNotApplicable
    ? " (channel broadcast — delivery acks apply to direct messages only)"
    : "";
  return `Sent to channel ${where}: "${r.text}"${note}`;
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
// contact management (companion-protocol; local-only)
// ---------------------------------------------------------------------------

/** Output schema for `import_contact`. */
export const importContactOutputShape = {
  imported: z.literal(true),
  lengthBytes: z.number().describe("number of advert-packet bytes consumed"),
} as const;

/** A one-line digest of an `import_contact` result. */
export function digestImportContact(r: { lengthBytes: number }): string {
  return `Imported contact (${r.lengthBytes} bytes of advert).`;
}

/** Output schema for `export_contact`. */
export const exportContactOutputShape = {
  name: z.string().describe("the exported contact's advertised name (or the home node's name)"),
  publicKey: z.string().describe("the exported contact's hex public key"),
  advertHex: z.string().describe("the advert packet as hex bytes — pass to another node's import_contact"),
} as const;

/** A one-line digest of an `export_contact` result. */
export function digestExportContact(r: { name: string; advertHex: string }): string {
  return `Exported "${r.name}" — ${r.advertHex.length / 2} bytes.`;
}

/**
 * Shared output schema for contact-operation tools that return just an
 * identity reference (`share_contact`, `remove_contact`, `reset_path`). Each
 * tool re-exports it under a tool-specific name so the surface stays
 * self-documenting at the registration site, but there's only one shape to
 * maintain.
 */
const contactIdentityShape = {
  name: z.string(),
  publicKey: z.string(),
} as const;

/** Output schema for `share_contact`. */
export const shareContactOutputShape = contactIdentityShape;

/** A one-line digest of a `share_contact` result. */
export function digestShareContact(r: { name: string }): string {
  return `Shared "${r.name}"'s advert mesh-wide.`;
}

/** Output schema for `remove_contact`. */
export const removeContactOutputShape = contactIdentityShape;

/** A one-line digest of a `remove_contact` result. */
export function digestRemoveContact(r: { name: string }): string {
  return `Removed "${r.name}" from the contact list.`;
}

/** Output schema for `reset_path`. */
export const resetPathOutputShape = contactIdentityShape;

/** A one-line digest of a `reset_path` result. */
export function digestResetPath(r: { name: string }): string {
  return `Cleared cached path to "${r.name}" — next direct send will re-discover.`;
}

/** Output schema for `set_contact_path`. */
export const setContactPathOutputShape = {
  name: z.string(),
  publicKey: z.string(),
  pathHex: z.string().describe("the path bytes that were written (hex)"),
} as const;

/** A one-line digest of a `set_contact_path` result. */
export function digestSetContactPath(r: { name: string; pathHex: string }): string {
  const hops = r.pathHex.length / 2;
  return hops === 0
    ? `Set direct path (0 hops) to "${r.name}".`
    : `Set path to "${r.name}" — ${hops} hop(s): ${r.pathHex}.`;
}

/** Output schema for `set_auto_add_contacts`. */
export const setAutoAddContactsOutputShape = {
  autoAdd: z.boolean().describe("the new auto-add state"),
} as const;

/** A one-line digest of a `set_auto_add_contacts` result. */
export function digestSetAutoAddContacts(r: { autoAdd: boolean }): string {
  return r.autoAdd
    ? "Auto-add enabled — new adverts will be added to the contact list."
    : "Auto-add disabled — new adverts will NOT be auto-added; use import_contact.";
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
  annotations: z
    .object({
      readOnlyHint: z.boolean(),
      destructiveHint: z.boolean(),
      idempotentHint: z.boolean(),
    })
    .describe(
      "the deterministic per-command risk hints this tier maps to; surfaced here " +
        "(not as MCP tool-level annotations) because `admin` is one multiplexed tool",
    ),
  dryRun: z.boolean(),
  via: z.enum(["home", "remote"]).optional(),
  preview: z.string().optional(),
  reply: z.string().optional(),
} as const;

/**
 * A digest of an {@link AdminResult} — the preview for a dry-run, else the
 * outcome. The `[tier]` tag carries the per-command risk; a `⚠` marks a
 * destructive command (from the tier's `destructiveHint`). The full
 * `{ readOnlyHint, destructiveHint, idempotentHint }` triple lives in the
 * structured output (`AdminResult.annotations`), this is just the prose hint.
 */
export function digestAdmin(node: string, r: AdminResult): string {
  const tag = r.annotations.destructiveHint ? `⚠ ${r.tier}` : r.tier;
  if (r.dryRun) {
    return `Dry-run [${tag}] ${r.command}: ${r.preview ?? ""}`;
  }
  const head = `${r.command} [${tag}] on ${node} — done (${r.via})`;
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
