/**
 * `registerServiceTool` — the one place the tool-handler boilerplate lives.
 *
 * Every service-backed tool has the same shape: validate input (the SDK does
 * that against `inputSchema`), call a `MeshService` method, render a one-line
 * digest + the structured result, and turn any thrown device error into an
 * actionable `isError` result via {@link toolError} (PRD §5.3, AGENTS.md
 * "structured, digested output + actionable errors"). This factory owns that
 * envelope once, so each tool file carries only its *logic*: which config
 * (title/description/schemas/annotations), which error context, and a `handle`
 * that calls the service and returns the final `{ text, structured }`.
 *
 * The single `structuredContent` widening cast — `structured as unknown as
 * Record<string, unknown>` — lives **here and nowhere else**. The SDK types
 * `structuredContent` as a `Record<string, unknown>` and validates it against
 * `outputSchema` at runtime; the schema is the real guarantee, so the named
 * result type is widened to that record shape in this one audited spot rather
 * than re-asserted in every tool (Finding #6).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import type { ErrorContext } from "../errors.js";
import { toolError } from "../errors.js";
import type { MeshService } from "../service/mesh-service.js";

/** The MCP config block for a tool — exactly the SDK's `registerTool` config. */
export interface ServiceToolConfig<InputShape extends ZodRawShape, OutputShape extends ZodRawShape> {
  /** Human title surfaced in the tool list. */
  title: string;
  /** The agent-facing description (enumerates behavior, params, formats). */
  description: string;
  /** The Zod input shape; the SDK validates args against it before `handle`. */
  inputSchema: InputShape;
  /** The Zod output shape; the SDK validates `structuredContent` against it. */
  outputSchema: OutputShape;
  /** The MCP tool annotations (read-only/destructive/idempotent/open-world hints). */
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** What a tool's `handle` produces: the digest text + the structured result. */
export interface ToolOutput {
  /** The one-line digest rendered into the `text` content block. */
  text: string;
  /**
   * The structured result. Validated against `outputSchema` at runtime; widened
   * to the SDK's `Record<string, unknown>` by the factory (the single cast).
   */
  structured: object;
}

/**
 * Everything a service-backed tool declares. The factory wraps {@link handle}
 * in the shared try/catch → {@link toolError} envelope and returns the
 * `{ content, structuredContent }` result.
 */
export interface ServiceToolSpec<InputShape extends ZodRawShape, OutputShape extends ZodRawShape> {
  /** The tool name (e.g. `"get_node_health"`). */
  name: string;
  /** The MCP config block (title/description/schemas/annotations). */
  config: ServiceToolConfig<InputShape, OutputShape>;
  /**
   * The error context for a failed call, derived from the validated args — the
   * `{ node?, attempted }` passed to {@link toolError} so messages stay
   * actionable and per-tool exact. Computed lazily so it can read the args.
   */
  errorContext: (args: ToolArgs<InputShape>) => ErrorContext;
  /**
   * The tool's logic. Has the `service` and the validated `args`; computes
   * everything it needs (including `service.now()` for digests, and any
   * structured shape that differs from the raw service result) and returns the
   * final `{ text, structured }`. Thrown errors are caught by the factory.
   */
  handle: (service: MeshService, args: ToolArgs<InputShape>) => Promise<ToolOutput>;
}

/**
 * The validated-args object the SDK hands a tool callback for a given input
 * shape. We infer it from the Zod shape so each tool's `handle`/`errorContext`
 * are typed against its own params with no per-tool annotation.
 */
type ToolArgs<InputShape extends ZodRawShape> = {
  [K in keyof InputShape]: import("zod").infer<InputShape[K]>;
};

/**
 * Register a service-backed tool on `server`, owning the handler boilerplate.
 *
 * Wraps {@link ServiceToolSpec.handle} in the shared try/catch: on success it
 * returns `{ content: [{ type: "text", text }], structuredContent }` (with the
 * single audited widening cast); on a thrown device error it returns
 * `toolError(error, errorContext(args))` — the actionable `isError` result.
 */
export function registerServiceTool<InputShape extends ZodRawShape, OutputShape extends ZodRawShape>(
  server: McpServer,
  service: MeshService,
  spec: ServiceToolSpec<InputShape, OutputShape>,
): void {
  server.registerTool(spec.name, spec.config, (async (args: ToolArgs<InputShape>) => {
    try {
      const { text, structured } = await spec.handle(service, args);
      return {
        content: [{ type: "text", text }],
        // The SDK validates `structuredContent` against `outputSchema` at
        // runtime; widen the typed result to that record shape here — the ONE
        // place this cast lives (Finding #6).
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return toolError(error, spec.errorContext(args));
    }
    // The SDK's `registerTool` callback type is keyed off the inferred input
    // shape; our generic `ToolArgs` mapping is structurally that args object,
    // but TS can't see through the SDK's compat-layer generics, so the callback
    // is asserted to the SDK's expected handler shape at this single seam.
  }) as Parameters<typeof server.registerTool>[2]);
}
