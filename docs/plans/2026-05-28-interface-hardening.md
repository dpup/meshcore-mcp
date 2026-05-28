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

## Issue backlog

| ID | Issue | Severity | Theme | Status |
|---|---|---|---|---|
| H1 | `get_node_health` fails atomically + mislabels a sub-call timeout as "unreachable" | high | A | open |
| H2 | Transient device timeouts surface as raw `-32603` in **resource** reads (no actionable error) | med | A | open |
| H3 | No retry/backoff/reconnect — node reboots & WiFi blips hit the consumer raw | high | A | open |
| H4 | Outbound sends are invisible in `get_recent_traffic` / live stream | med | B | open |
| H5 | V3 message frames (0x10/0x11) undecoded by meshcore.js 1.13 → missed/stalled messages | high | B (upstream) | open |
| H6 | Bad channel target says "No contact matches" — `#`-targets should resolve as channels and list known channels on miss | med | — | open |
| H7 | No `delete_channel` (can add, can't remove) | low | — | open |
| H8 | `admin` unknown-command error is verbose raw Zod JSON | low | — | open |
| C1 | Channel discovery + add (`meshcore://channels` + `set_channel`) | — | — | **done (1588497)** |

---

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
