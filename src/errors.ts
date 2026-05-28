/**
 * Turn a caught device error into an **actionable** MCP tool error result.
 *
 * The two contracts meet here: below, `@dpup/meshcore-ts` throws typed errors
 * (`MeshCoreError` / `MeshCoreTimeoutError` / `MeshCoreDeviceError`) for a
 * device that did not answer, timed out, or returned an error code; above, MCP
 * wants a *result* (`{ isError: true, content: [...] }`), never a thrown
 * exception escaping the handler (PRD §5.3). Every read/action tool wraps its
 * service call in a try/catch and routes the caught value through
 * {@link toolError}, so an unreachable node yields a high-signal message — not a
 * crash.
 */

import {
  MeshCoreDeviceError,
  MeshCoreError,
  MeshCoreTimeoutError,
} from "@dpup/meshcore-ts";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { Clock } from "./clock.js";
import { formatRelative } from "./time.js";

/**
 * The shape of an MCP tool error result (a `CallToolResult` with `isError`).
 *
 * The open index signature mirrors the SDK's `CallToolResult` (which carries
 * `[x: string]: unknown`), so a returned {@link ToolErrorResult} is assignable
 * straight into a tool handler's result type with no cast.
 */
export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

/** Context that sharpens an error message into something an operator can act on. */
export interface ErrorContext {
  /** The node the failing operation targeted (name or key prefix), if any. */
  node?: string;
  /** What was attempted, in plain words — e.g. `"read status"`, `"send message"`. */
  attempted?: string;
  /**
   * When the node was last heard, as injected-clock ms. Rendered as a relative
   * "last heard …" suffix using {@link clock} for "now".
   */
  lastHeardMs?: number;
  /** The injected clock, for the relative-time suffix. Never `Date.now()`. */
  clock?: Clock;
}

/**
 * Build an actionable tool error result from a caught value and context.
 *
 * Produces messages like:
 * - `rocky-ridge unreachable: no response (timed out); last heard 2h ago`
 * - `rocky-ridge: device error: not found (while reading status)`
 *
 * @param error - The caught value (ideally a {@link MeshCoreError}).
 * @param ctx - Optional node / attempt / last-heard context.
 */
export function toolError(error: unknown, ctx: ErrorContext = {}): ToolErrorResult {
  const prefix = ctx.node ? `${ctx.node} ` : "";
  let body: string;

  if (error instanceof MeshCoreTimeoutError) {
    body = `unreachable: no response (timed out — the node may be offline or out of range)`;
  } else if (error instanceof MeshCoreDeviceError) {
    body = `unreachable: ${error.message.toLowerCase()}`;
  } else if (error instanceof MeshCoreError) {
    // A generic MeshCoreError is usually a *usage* error (unknown contact /
    // channel, bad admin params) rather than a connectivity failure — surface
    // its message directly; "unreachable" is reserved for timeout/device errors.
    body = error.message;
  } else if (error instanceof Error) {
    body = error.message;
  } else {
    body = String(error);
  }

  const attempted = ctx.attempted ? ` (while ${ctx.attempted})` : "";
  const lastHeard =
    ctx.lastHeardMs !== undefined && ctx.clock !== undefined
      ? `; last heard ${formatRelative(ctx.clock.now() - ctx.lastHeardMs)}`
      : "";

  return {
    isError: true,
    content: [{ type: "text", text: `${prefix}${body}${attempted}${lastHeard}` }],
  };
}

/**
 * The MCP `resources/read` result has no `isError` flag, so a thrown error
 * becomes a JSON-RPC error — the SDK's default is the opaque `-32603 Request
 * timed out waiting for a device response`. This helper rethrows the caught
 * value as an {@link McpError} carrying the same **actionable, prefixed**
 * message {@link toolError} produces — so the client gets a clean, useful
 * error instead of a raw protocol code.
 */
export function resourceReadError(
  uri: string,
  error: unknown,
  attempted: string,
): never {
  const formatted = toolError(error, { attempted });
  const text = formatted.content[0]?.text ?? "device error";
  // eslint-disable-next-line @typescript-eslint/no-throw-literal
  throw new McpError(ErrorCode.InternalError, `${uri}: ${text}`);
}
