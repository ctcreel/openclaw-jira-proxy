import type { JsonSchema } from './types';

/**
 * Result of resolving a dotted path against a JSON Schema.
 *
 * `exists: true, schema: undefined` means the path resolved into a
 * passthrough/additionalProperties-true subtree where we no longer know
 * the type — the path is acceptable but the audit can't say anything
 * specific about its leaf.
 */
export interface PathLookup {
  readonly exists: boolean;
  readonly schema?: JsonSchema;
}

/**
 * Resolve a dotted path (e.g. `issue.fields.status.name`) against a
 * JSON Schema. Returns whether the path exists and, when known, the
 * schema at the resolved leaf.
 *
 * Audit semantics distinguish two flavors of "open":
 *   - `passthrough: true` is the explicit opt-in for "anything under
 *     here is valid by design" (e.g. dispatched-context fields whose
 *     names the upstream rule chooses). Audit accepts any descent.
 *   - `additionalProperties: true` with NO declared `properties` is
 *     also fully open — we genuinely don't know the shape.
 *   - `additionalProperties: true` WITH declared `properties` is the
 *     forward-compat / partial-modeling case: known fields are typed,
 *     unknown segments are reported as unknown so the audit catches
 *     typos like `issue.field.summary` (missing 's'). The runtime
 *     would still validate the value, but the audit's job is catching
 *     intent typos before deploy.
 */
export function resolvePath(rootSchema: JsonSchema, path: string): PathLookup {
  const segments = path.split('.').filter((s) => s !== '');
  let current: JsonSchema = rootSchema;
  for (const segment of segments) {
    const next: JsonSchema | undefined = current.properties?.[segment];
    if (next !== undefined) {
      current = next;
      continue;
    }
    if (isFullyOpen(current)) return { exists: true };
    return { exists: false };
  }
  return { exists: true, schema: current };
}

/**
 * Resolve a path that's expected to terminate at an array and return
 * the array's item schema. Used by `any_item` condition handling — the
 * path resolves to an array, then the `where` clause's paths are
 * relative to each item.
 */
export function resolveArrayItem(rootSchema: JsonSchema, path: string): PathLookup {
  const result = resolvePath(rootSchema, path);
  if (!result.exists) return result;
  if (result.schema === undefined) return result; // passthrough — accept
  const schema = result.schema;
  if (schema.type === 'array' && schema.items !== undefined) {
    return { exists: true, schema: schema.items };
  }
  return { exists: true, schema };
}

function isFullyOpen(schema: JsonSchema): boolean {
  if (schema.passthrough === true) return true;
  if (schema.additionalProperties === true && schema.properties === undefined) return true;
  return false;
}
