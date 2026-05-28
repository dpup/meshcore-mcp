# meshcore-mcp — Interface hardening backlog

**Status:** active · **Source:** live-node play session against SIERRA Elmer (2026-05-28)

A tracking backlog of interface issues found by exercising the server against a
real node, plus two cross-cutting themes that generalize them. IDs are stable;
check items off as they land.

---

## Theme A — Resilience: retry/backoff + reconnection

**Why.** A real node intermittently times out on a companion query (~1 in 3
`get_node_health` calls), reboots (during `admin reboot`, or OTA), and sits on a
flaky WiFi link. Today any of these surfaces straight to the MCP consumer as a
failure — and `get_node_health`, which fans out to ~6 sequential calls, fails
*atomically* and is mislabeled "unreachable." We should absorb transient device
trouble before surfacing it.

**Design.**
- A single **`request` path** in `MeshService` wraps device calls with bounded
  **retry + exponential backoff**, driven by the **injected `Clock`** (so it's
  deterministic and testable with `SimClock`, not wall-clock sleeps).
- **Idempotency-keyed policy** — this is the crux. We already encode idempotency
  (tool annotations; admin risk tiers):
  - **Idempotent** ops (all reads, `set-*` config, `set_channel`): retry on
    transient errors (`MeshCoreTimeoutError`, connection-dropped).
  - **Non-idempotent** ops (`send_message`, `advert`, `reboot`): **do not**
    auto-retry once the frame is on the wire (a resend re-transmits / re-acts).
    Retrying a *pre-send connection failure* is still safe and allowed.
- **Reconnection.** On a dropped connection (reboot/WiFi blip), reconnect with
  backoff, then resume; idempotent in-flight calls retry, non-idempotent ones
  fail cleanly with an actionable error. (Check whether `MeshCoreClient`
  reconnects in place or must be rebuilt.)
- **Aggregates degrade gracefully** — `get_node_health` gathers sub-results
  independently (`Promise.allSettled`-style) and returns a **partial snapshot**
  marking what's missing, instead of failing whole. A sub-call timeout is *not*
  "unreachable" when other calls to the same node succeed.

**Open decisions:** backoff params (default ~3 attempts, 200ms × 2ⁿ, cap ~2s);
whether retry lives in `MeshService` or a small `resilientClient` wrapper.

---

## Theme B — Message visibility (outbound + a unified log)

**Finding (authoritative — firmware `companion_protocol.md`).** The companion
protocol is **consume-once inbound**: `CMD_SYNC_NEXT_MESSAGE` drains queued
*received* messages; there is **no get-history and no get-sent command**. A send
yields only a `PACKET_MSG_SENT` ack — the device never stores or serves the sent
text. So "other clients know about outbound" = those clients persist their **own
local history**; it is *not* read back from the device.

**Implications / design.**
- We **cannot** read outbound (or any history) from the device, and **cannot**
  see sends made by *other* clients — a protocol limitation to document, not a
  bug to fix.
- What we *can* do: **record our own outbound sends** (`send_message`, channel
  sends) into the traffic buffer at send time, so messages sent **through this
  server** appear in `get_recent_traffic` and the live stream — a unified
  inbound+outbound session log. This is the "cache" — maintained by us, since the
  device serves nothing to re-read.
- **Limitation to document:** the log is session-scoped (a server restart can't
  recover past messages — the device doesn't persist them for us) and covers our
  own sends + received traffic, not other clients' sends.

**Related upstream gap (H7).** The firmware now emits **V3 message frames**
(`PACKET_CONTACT_MSG_RECV_V3` 0x10 / `PACKET_CHANNEL_MSG_RECV_V3` 0x11, with SNR)
that **meshcore.js 1.13 doesn't decode** (see meshcore-ts AGENTS gotcha #7) — so
on current firmware some received messages surface only as raw `rx` frames and
can stall `syncNextMessage`. This directly degrades `get_recent_traffic` / the
live stream and likely contributes to the timeouts. It's an upstream
(meshcore.js → meshcore-ts) fix; track + raise it, and consider a stopgap.

---

## Live re-verification (2026-05-28)

The whole backlog was re-exercised against the real node (SIERRA Elmer) through
the production server and all fixes held:

- **H1** — 3/3 `get_node_health` clean (stderr showed retries absorbing transient
  timeouts that previously failed ~1/3 of calls).
- **H3** — `admin reboot` → `device disconnected; reconnect attempt 1… → device
  reconnected`; `get_node_health` working again within ~9s on the same session,
  no client intervention. **Auto-reconnect verified on hardware.**
- **H4** — a send appeared in `get_recent_traffic` as `direction:"out"`.
- **H6** — `#nope` → `no channel matches "#nope". Known channels: #Public, …`.
- **H7** — `set_channel` + `delete_channel` add/remove cleanly (left the node tidy).
- **H8** — unknown admin command → the friendly valid-command list, no Zod JSON.
- `trace_path` — an unresponsive path returns a graceful actionable timeout.

## Issue backlog

| ID | Issue | Severity | Theme | Status |
|---|---|---|---|---|
| H1 | `get_node_health` fails atomically + mislabels a sub-call timeout as "unreachable" | high | A | **done (01bf0a1)** |
| H2 | Transient device timeouts surface as raw `-32603` in **resource** reads (no actionable error) | med | A | **done (eaf7d2b)** |
| H3 | No retry/backoff/reconnect — node reboots & WiFi blips hit the consumer raw | high | A | **done (01bf0a1)** |
| H4 | Outbound sends are invisible in `get_recent_traffic` / live stream | med | B | **done (f904b8e)** |
| H5 | V3 message frames (0x10/0x11) undecoded by meshcore.js 1.13 → missed/stalled messages | high | B (upstream) | **raised (meshcore-ts#3)** |
| H6 | Bad channel target says "No contact matches" — `#`-targets should resolve as channels and list known channels on miss | med | — | **done (f904b8e)** |
| H7 | No `delete_channel` (can add, can't remove) | low | — | **done (432d39c)** |
| H8 | `admin` unknown-command error is verbose raw Zod JSON | low | — | **done (432d39c)** |
| C1 | Channel discovery + add (`meshcore://channels` + `set_channel`) | — | — | **done (1588497)** |

---

## Workflow probe — send → monitor acks → report repeats (W1, design)

A mesh propagation/health probe: send a message, watch for the delivery ack, and
report how many repeats were observed — "is the mesh carrying my traffic, and how
far?" Researched against meshcore.js + the firmware `companion_protocol.md`, and
tested against the live node.

**What's actually observable:**
- **Send** → `sendTextMessage` returns `{ result (route: 0=direct / 1=flood),
  expectedAckCrc, estTimeout }` (`PACKET_MSG_SENT` 0x06). We learn the route, the
  ack tag to match, and how long to wait. (`sendChannelTextMessage` returns
  **void** — see below.)
- **Ack** (clean) → `sendConfirmed { ackCode, roundTrip }` (`PACKET_ACK` 0x82).
  Match `ackCode === expectedAckCrc` for a precise delivery confirmation + RTT.
  **Acks are a direct-message thing** — a broadcast (channel/flood) has no single
  recipient to ack, so channel sends produce no `sendConfirmed`.
- **Repeats** (coarse only) → a repeater rebroadcasting your flood is heard as a
  generic RF-log frame: `logRxData`/`rawData` (`PACKET_LOG_DATA` 0x88, "can be
  ignored"), opaque bytes. We can **count RF frames in the window** but cannot
  attribute them to *our* packet without parsing the raw bytes (meshcore-ts
  leaves them opaque). So "repeats" is an approximate "RF frames heard," not a
  verified per-message repeat count.

**Live test (isolated node):** a channel send returned void; over 8s, **zero**
events of any kind. SIERRA Elmer has no contacts and no peers in range, so it
can't exercise acks (no contact to send a direct message to) or repeats (no
repeaters). The workflow needs a real multi-node mesh; it's built and tested
against the **sim** (which can script an ack + RF-frame "repeats" deterministically).

**Proposed shape:** a `probe_send(target, text, window?)` tool +
`MeshService.probeSend` — send, then over a clock-driven window collect the
matching `sendConfirmed` (ack + RTT) and count `logRxData`/`rawData` frames,
returning `{ route, ack: { received, roundTripMs? }, rfFramesObserved, windowMs }`.
A clean "collapse the mechanical sequence" tool (PRD §4); the agent interprets.

**Decision (2026-05-28): held for *precise* repeats — not shipping a coarse
count.** A coarse "RF frames heard" number would mislead more than help. The
precise count is **blocked on [meshcore-ts#4](https://github.com/dpup/meshcore-ts/issues/4)**
(parse RF-log frames into packet hashes, so a received rebroadcast can be matched
to the packet we sent). `probe_send` is deferred until that lands; then the ack
half (already clean) + a verified repeat count make the whole workflow honest.
(`tracePath` shipped as a separate `trace_path` tool — precise route + per-hop
SNR, independent of the repeat-attribution blocker.)

## trace_path (shipped)

A standalone `trace_path(path? | node?)` tool: send a trace packet along an
explicit hop path (`"23,5f,3a"`) or a contact's known out-path, and report each
repeater hop's SNR — a precise propagation/coverage probe. Not retry-wrapped (it
transmits a probe and carries its own device timeout; a timeout is a *result*).
Verified: path-byte encoding + hop/SNR mapping (sim + unit-via-spy), the error
paths, and a graceful live timeout against the isolated node.

## Proposed sequence

1. **H1 + H3 (Theme A foundation):** the clock-driven, idempotency-keyed retry
   path in `MeshService`, and make `get_node_health` degrade gracefully. Highest
   leverage — also fixes H2 for most cases.
2. **H2:** consistent error handling for resource reads (catch device errors).
3. **H4:** record outbound sends into the buffer (the achievable half of Theme B).
4. **H6:** channel-aware target resolution + helpful errors.
5. **H5:** raise the V3-frame gap upstream (meshcore-ts); evaluate a stopgap.
6. **H7, H8:** `delete_channel`; friendlier admin validation error.

Each lands behind the usual gates (typecheck · test · build · docs:check) and,
where it touches device behavior, a sim-backed test + a live-node check.
