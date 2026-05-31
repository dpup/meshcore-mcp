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

import { adminOutputShape, digestAdmin } from "../format.js";
import type { RiskTier } from "../service/admin.js";
import { ADMIN_COMMANDS } from "../service/admin.js";
import type { MeshService } from "../service/mesh-service.js";
import { registerServiceTool } from "./register.js";

/** Display order for tier headers in {@link commandCatalogue}. Risk-ascending. */
const TIER_ORDER: readonly RiskTier[] = ["read", "benign", "config", "sensitive", "destructive"];

/** Short human heading per tier, used by {@link commandCatalogue}. */
const TIER_HEADING: Record<RiskTier, string> = {
  read: "Read",
  benign: "Benign",
  config: "Config",
  sensitive: "Sensitive (writes secrets / grants access)",
  destructive: "Destructive (data/identity loss or reboot)",
};

/**
 * The full admin catalogue, grouped by risk tier. Each entry is one line:
 * `<name> [<scope>] — <params>`. Reused verbatim by the `admin` tool's
 * description and the `meshcore://help` document, so the surface that an agent
 * discovers (tools.list + the pull-on-demand reference) stays in lock-step
 * with the registry. Tier grouping makes destructive/sensitive commands easy
 * to find without changing the source of truth.
 */
export function commandCatalogue(): string {
  const sections: string[] = [];
  for (const tier of TIER_ORDER) {
    const entries = Object.values(ADMIN_COMMANDS).filter((def) => def.tier === tier);
    if (entries.length === 0) continue;
    sections.push(`${TIER_HEADING[tier]}:`);
    for (const def of entries) {
      const shape = paramSummary(def.params);
      const params = shape === "" ? "no params" : shape;
      const scope = def.scope === "remote-only" ? "remote" : "home+remote";
      sections.push(`  • ${def.name} [${scope}] — ${params}`);
    }
    sections.push("");
  }
  return sections.join("\n").trimEnd();
}

/**
 * Summarize a command's Zod object schema as a compact `key: hint` list, using
 * only Zod's **public** surface — the {@link z.ZodObject.shape} getter for the
 * fields and each field's public `.description` getter for the hint. Best effort
 * and human-facing only (the tool description + `meshcore://help`); never used to
 * validate. A non-object schema (e.g. the empty-params commands) yields `""`.
 */
function paramSummary(schema: z.ZodTypeAny): string {
  // Discriminated-union schemas (region / gps / sensor) are not ZodObjects —
  // they're ZodDiscriminatedUnion. Render them by listing the discriminator
  // key, every literal value it can take, and the extra params each branch
  // adds beyond the discriminator. Without this, the catalogue rendered
  // these commands as 'no params', hiding their entire subcommand surface.
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return summarizeDiscriminatedUnion(schema);
  }
  if (!(schema instanceof z.ZodObject)) return "";
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const keys = Object.keys(shape);
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${describeField(shape[k])}`).join(", ");
}

/**
 * Render a {@link z.ZodDiscriminatedUnion} as `<disc>: <a> [<a-extras>] | <b>
 * [<b-extras>] | …`. For each branch (a `ZodObject`), list the literal value
 * of the discriminator, then any *additional* params the branch carries
 * beyond the discriminator itself. Keeps the agent's mental model: "pick one
 * sub-action, then provide its arguments."
 */
function summarizeDiscriminatedUnion(
  schema: z.ZodDiscriminatedUnion<string, z.ZodObject<z.ZodRawShape>[]>,
): string {
  const disc = schema.discriminator;
  const branches = schema.options.map((branch) => {
    const shape = branch.shape as Record<string, z.ZodTypeAny>;
    const value = (shape[disc] as { value?: unknown } | undefined)?.value;
    const valueText = typeof value === "string" ? value : JSON.stringify(value);
    const extraKeys = Object.keys(shape).filter((k) => k !== disc);
    if (extraKeys.length === 0) return valueText;
    const extras = extraKeys.map((k) => `${k}: ${describeField(shape[k])}`).join(", ");
    return `${valueText} (${extras})`;
  });
  return `${disc}: ${branches.join(" | ")}`;
}

/**
 * A human hint for one Zod field (for the description only). Reads the field's
 * own public `.description` — set via `.describe()`, which is where the unit +
 * accepted-format guidance lives for the fuzzy-friendly params (`coerce.ts`) and
 * for every admin param. A field with no description falls back to a single
 * generic label; we deliberately do **not** reflect on Zod's internal type names
 * (a version bump can rename them silently), so missing hints are caught by the
 * catalogue guard test instead.
 */
function describeField(field: z.ZodTypeAny | undefined): string {
  const description = field?.description;
  return description !== undefined && description !== "" ? description : "value";
}

/** Register the `admin` action tool on `server`, backed by `service`. */
export function registerAdmin(server: McpServer, service: MeshService): void {
  registerServiceTool(server, service, {
    name: "admin",
    config: {
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
    errorContext: ({ node, command }) => ({ node, attempted: `running admin "${command}"` }),
    handle: async (svc, { node, command, params, dryRun }) => {
      const result = await svc.runAdmin(node, command, params, dryRun ?? false);
      return { text: digestAdmin(node, result), structured: result };
    },
  });
}
