/**
 * `registerJsonResource` — the one place the JSON-resource read boilerplate
 * lives.
 *
 * Every pull-style JSON resource has the same envelope: read something from the
 * `MeshService`, serialize it as pretty-printed JSON under
 * `mimeType: "application/json"`, and turn any thrown device error into an
 * actionable {@link resourceReadError} (PRD §5.2/§5.3, AGENTS.md "structured,
 * digested output + actionable errors"). This factory owns that envelope once,
 * so each resource file carries only its *logic*: what to load and the exact
 * `attempted` phrase for its error context (Finding #6).
 *
 * The emitted `contents[].uri` is always the **actual request uri** — `uri.href`
 * for a string resource, the realized template uri for a `ResourceTemplate`
 * read — picked from the single source the SDK hands the read callback. That is
 * the one consistent convention across every JSON resource (previously some
 * used `uri.href`, some a hand-held constant).
 */

import type { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";

import { resourceReadError } from "../errors.js";

/** The `ResourceMetadata` config block — title/description/mimeType. */
export interface JsonResourceMetadata {
  /** Human title surfaced in the resource list. */
  title: string;
  /** The agent-facing description. */
  description: string;
  /** The MIME type; always `"application/json"` for these resources. */
  mimeType: string;
}

/**
 * What a JSON resource declares: its name, its uri (a fixed string or a
 * `ResourceTemplate`), the read metadata, the `attempted` phrase for error
 * context, and a `load` that returns the value to serialize. `attempted` can be
 * a function of `(uri, variables)` so a template resource can name its resolved
 * target (e.g. `reading node "Rocky Ridge"`).
 */
export interface JsonResourceSpec {
  /** The resource name (e.g. `"nodes"`). */
  name: string;
  /** A fixed uri string or a `ResourceTemplate` (with completion wiring). */
  uri: string | ResourceTemplate;
  /** The read metadata (title/description/mimeType). */
  metadata: JsonResourceMetadata;
  /**
   * The plain-words phrase passed to {@link resourceReadError} (e.g. `"reading
   * mesh roster"`). A function form receives the request uri + template
   * variables so it can name the resolved target.
   */
  attempted: string | ((uri: URL, variables: Variables) => string);
  /**
   * The resource's logic. Has the request `uri` and any template `variables`;
   * returns the value to serialize as JSON. Thrown errors are caught and routed
   * through {@link resourceReadError}.
   */
  load: (uri: URL, variables: Variables) => Promise<unknown>;
}

/**
 * Register a pull-style JSON resource on `server`, owning the read boilerplate.
 *
 * Wraps {@link JsonResourceSpec.load} in the shared try/catch: on success it
 * returns the single-content envelope with the request uri,
 * `application/json`, and `JSON.stringify(value, null, 2)`; on a thrown device
 * error it routes through {@link resourceReadError} (which throws an actionable
 * `McpError`).
 */
export function registerJsonResource(server: McpServer, spec: JsonResourceSpec): void {
  const read = async (uri: URL, variables: Variables): Promise<ReadResourceResult> => {
    try {
      const value = await spec.load(uri, variables);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: spec.metadata.mimeType,
            text: JSON.stringify(value, null, 2),
          },
        ],
      };
    } catch (error) {
      const attempted =
        typeof spec.attempted === "function" ? spec.attempted(uri, variables) : spec.attempted;
      resourceReadError(uri.href, error, attempted);
    }
  };

  if (typeof spec.uri === "string") {
    server.registerResource(spec.name, spec.uri, spec.metadata, (uri) => read(uri, {}));
  } else {
    server.registerResource(spec.name, spec.uri, spec.metadata, (uri, variables) =>
      read(uri, variables),
    );
  }
}
