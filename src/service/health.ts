/**
 * The unified, intent-shaped result types {@link MeshService}'s read methods
 * return — `nodeHealth` and `surveyMesh`. They are deliberately *not* a 1:1
 * passthrough of the device client's models: they collapse the home-vs-remote
 * distinction and the remote login (PRD §4), so a tool — and ultimately an agent
 * — sees one coherent snapshot regardless of how the data was assembled.
 *
 * These types are the service's **intent** surface, and they hold only what the
 * device reports — the line is *lossless vs. interpretive*. Lossless unit
 * normalization (the radio kHz→MHz / Hz→kHz conversions) stays here: it shapes a
 * device wire quirk into the canonical surface units this contract documents.
 * Interpretive, lossy derivation does **not** belong here — e.g. battery carries
 * raw millivolts only; volts and the 1S Li-ion charge **%** are a chemistry
 * estimate and are added by the presentation layer (`format.ts`), so a second
 * `NodeHealth` consumer (meshcore-elmer) never inherits the device core's
 * battery-chemistry opinion.
 *
 * The output schemas in `format.ts` mirror these shapes but may add
 * presentation-derived fields (battery `volts`/`percent`); see `format.ts`.
 */

import type { AdvType } from "@dpup/meshcore-ts";

/**
 * A consolidated health snapshot for one node — the connected **home** node, or
 * a **remote** node reached over the mesh. The `kind` discriminant says which,
 * and which optional fields are populated.
 *
 * - **home** (`getSelfInfo` + `getBatteryVoltage` + `getDeviceTime` +
 *   `getStats*`): full identity, radio config, battery, uptime/queue, and
 *   packet/radio counters.
 * - **remote** (`login` → `getStatus` + `getTelemetry`): the repeater's reported
 *   stats and an opaque telemetry byte length. No radio config is read (the home
 *   node cannot see a remote's full `SelfInfo`).
 */
export interface NodeHealth {
  /** Which assembly path produced this snapshot. */
  kind: "home" | "remote";
  /**
   * The node this snapshot is for: its advertised name where known, else the
   * caller's reference (a name or hex pubkey prefix). For the home node, its
   * advertised name.
   */
  node: string;
  /** Hex public key (full for home/known contacts), where resolvable. */
  publicKey?: string;
  /** Advertised role/type of the node, where known. */
  role?: AdvType;
  /** Whether the node answered — always `true` here (a failed read throws). */
  reachable: boolean;
  /**
   * When the node was last heard, as injected-clock ms. For the home node this
   * is the device time; for a remote it is its last advert (`lastAdvert`),
   * where derivable.
   */
  lastHeardMs?: number;

  /**
   * Battery, where reported (home: `getBatteryVoltage`; remote: stats) — **raw
   * millivolts only**. Derived `volts` and an approximate charge `%` are a
   * chemistry interpretation (lossy), so they are *not* carried here; the
   * presentation layer (`format.ts`) adds them on the wire.
   */
  battery?: {
    milliVolts: number;
  };

  /** Radio configuration — home node only (read from `SelfInfo`). */
  radio?: {
    /** Centre frequency, in MHz (device wire unit is kHz; normalised here). */
    freqMhz: number;
    /** Bandwidth, in kHz (device wire unit is Hz; normalised here). */
    bwKhz: number;
    /** Spreading factor. */
    sf: number;
    /** Coding-rate denominator. */
    cr: number;
    /** Transmit power, in dBm. */
    txPower: number;
    /** Maximum transmit power the board supports, in dBm. */
    maxTxPower: number;
  };

  /** Uptime / queue depth, where reported. */
  uptimeSecs?: number;
  /** Current TX queue length, where reported. */
  txQueueLen?: number;

  /**
   * Packet / radio counters, where reported. Home: from `getStats*`. Remote:
   * from `getStatus` (RepeaterStats). Only the fields the source carried are
   * present.
   */
  stats?: {
    packetsReceived?: number;
    packetsSent?: number;
    recvFlood?: number;
    recvDirect?: number;
    sentFlood?: number;
    sentDirect?: number;
    noiseFloor?: number;
    lastRssi?: number;
    lastSnr?: number;
    /** Total airtime, in seconds (remote repeaters). */
    totalAirTimeSecs?: number;
    /** Error events counter (remote repeaters). */
    errEvents?: number;
  };

  /**
   * Device time as injected-clock ms — home node only (`getDeviceTime`). The
   * mesh device's own clock, useful for drift checks.
   */
  deviceTimeMs?: number;

  /**
   * Opaque telemetry payload length, in bytes — remote node only. Telemetry is
   * Cayenne-LPP encoded; we do not decode it (PRD §4), only report its size so
   * an agent can tell whether the node is reporting sensors.
   */
  telemetryBytes?: number;

  /**
   * Names of sub-calls that failed after retries — present only when the
   * snapshot is partial (some fields will be absent). `reachable` stays `true`
   * because the node *did* answer the identification call; only some follow-up
   * reads timed out. Use this to disambiguate "the field genuinely isn't
   * available" from "we couldn't read it this time."
   */
  degraded?: string[];
}

/** One contact in a {@link MeshSurvey} roster. */
export interface SurveyContact {
  /** Advertised display name. */
  name: string;
  /** 32-byte public key, hex encoded. */
  publicKey: string;
  /** Advertised role/type. */
  role: AdvType;
  /** When this contact was last heard (advert), as injected-clock ms. */
  lastHeardMs: number;
}

/**
 * The home node plus its full contact roster — the `survey_mesh` result. One
 * consolidated view of who is reachable through this node, with last-heard
 * times so an agent can spot a quiet node.
 */
export interface MeshSurvey {
  /** The connected home node. */
  home: {
    /** Advertised display name. */
    name: string;
    /** 32-byte public key, hex encoded. */
    publicKey: string;
    /** Advertised role/type. */
    role: AdvType;
  };
  /** Known contacts, with last-heard times. */
  contacts: SurveyContact[];
}
