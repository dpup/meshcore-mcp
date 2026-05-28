/**
 * `admin` — the single, enumerated admin tool (PRD §5.1, §5.3; execution plan §9).
 *
 * `admin` is **never** free-form text: its `command` must name one of
 * {@link ADMIN_COMMANDS}'s keys, and params are validated against that command's
 * Zod schema. The `command` arg itself is a bare `z.string()` (not a `z.enum`)
 * **on purpose**: the MCP SDK validates the input schema before this handler
 * runs, so a `z.enum` would reject an unknown name with raw Zod JSON; instead
 * {@link MeshService.runAdmin} looks the name up and throws a friendly
 * `AdminCommandError` listing the valid commands ({@link ADMIN_COMMAND_NAMES}),
 * which the handler catches into an actionable `isError` result (H8).
 *
 * The tool carries **conservative static annotations** (`readOnlyHint: false`,
 * `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`)
 * because the set *can* be destructive and a single multiplexed tool can't carry
 * per-command annotations. The **per-command risk** is surfaced in the
 * structured output instead: the `tier` plus the deterministic
 * `{ readOnlyHint, destructiveHint, idempotentHint }` triple it maps to
 * (`annotationsForTier`), in {@link AdminResult.annotations}. The description
 * also enumerates every command with its tier + params, so an agent can discover
 * the surface. Dispatch — home structured method vs. remote
 * `login → CliData → reply` — lives in {@link MeshService.runAdmin}.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { adminOutputShape, digestAdmin } from "../format.js";
import { ADMIN_COMMANDS } from "../service/admin.js";
import type { MeshService } from "../service/mesh-service.js";

/**
 * A one-line `name [tier, scope] — params` summary per command, so the tool's
 * description enumerates the whole surface (kept in lock-step with the registry).
 * Exported so the `meshcore://help` resource reuses the same generated catalogue.
 */
export function commandCatalogue(): string {
  return Object.values(ADMIN_COMMANDS)
    .map((def) => {
      const shape = paramSummary(def.params);
      const params = shape === "" ? "no params" : shape;
      return `  • ${def.name} [${def.tier}, ${def.scope}] — ${params}`;
    })
    .join("\n");
}

/**
 * Summarize a command's Zod object schema as a compact `key: type` list. Best
 * effort — used only to enrich the human-facing tool description, never to
 * validate.
 */
function paramSummary(schema: z.ZodTypeAny): string {
  const def: unknown = (schema as { _def?: unknown })._def;
  const shapeFn = (def as { shape?: unknown } | undefined)?.shape;
  const shape =
    typeof shapeFn === "function"
      ? (shapeFn as () => Record<string, z.ZodTypeAny>)()
      : ((def as { shape?: Record<string, z.ZodTypeAny> } | undefined)?.shape ?? {});
  const keys = Object.keys(shape);
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${describeField(shape[k])}`).join(", ");
}

/**
 * A human hint for one Zod field (for the description only). Prefers the field's
 * own `.describe()` text — which is where the unit + accepted-format guidance
 * lives for fuzzy-friendly params (`coerce.ts`) — then unwraps effect/optional
 * wrappers, then falls back to a coarse type name.
 */
function describeField(field: z.ZodTypeAny | undefined): string {
  const def = (field as { _def?: Record<string, unknown> } | undefined)?._def;
  if (def === undefined) return "value";
  if (typeof def.description === "string" && def.description !== "") return def.description;
  // Unwrap z.preprocess/transform (ZodEffects: `.schema`) and
  // optional/nullable/default (`.innerType`) to the underlying field.
  const inner = (def.schema ?? def.innerType) as z.ZodTypeAny | undefined;
  if (inner !== undefined) return describeField(inner);
  switch (def.typeName) {
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return "enum";
    case "ZodString":
      return "string";
    default:
      return "value";
  }
}

/** Register the `admin` action tool on `server`, backed by `service`. */
export function registerAdmin(server: McpServer, service: MeshService): void {
  server.registerTool(
    "admin",
    {
      title: "Run an admin command",
      description:
        "Run one enumerated admin command against a node. `node` is the home " +
        "node (its name or key prefix) or a remote repeater (name / hex prefix). " +
        "Pass `dryRun: true` to preview the intent without contacting the device. " +
        "Each command carries a risk tier (surfaced in the result). Commands:\n" +
        commandCatalogue(),
      inputSchema: {
        node: z.string(),
        command: z
          .string()
          .describe(
            "the admin command name (see the catalogue in this description); an unknown name returns the valid list",
          ),
        params: z.record(z.unknown()).optional(),
        dryRun: z.boolean().optional(),
      },
      outputSchema: adminOutputShape,
      // Conservative static annotations: the set *can* be destructive, so the
      // tool is marked destructive + non-idempotent; the per-command tier is in
      // the structured output (execution plan §9).
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ node, command, params, dryRun }) => {
      try {
        const result = await service.runAdmin(node, command, params, dryRun ?? false);
        return {
          content: [{ type: "text", text: digestAdmin(node, result) }],
          // Widen to the SDK's record shape; the outputSchema validates it.
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return toolError(error, { node, attempted: `running admin "${command}"` });
      }
    },
  );
}
