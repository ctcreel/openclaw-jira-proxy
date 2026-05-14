import { z } from 'zod';

/**
 * Tool definition file (`tool.yaml`) shape. Hand-written by the tool author,
 * adjacent to the tool's `impl.py`.
 *
 * Args are required by default; `optional: true` flags the exception. The
 * Anthropic JSON Schema `required:` list is derived by collecting every arg
 * key without `optional: true`.
 *
 * Secrets are declared as a map from the canonical kwarg name (passed to
 * `invoke()`) to the env-alias list operators may use to provide the value.
 * A bare string is shorthand for a single alias; an array lists multiple
 * acceptable bindings (first hit wins). The canonical name decouples the
 * tool's interface from the operator's deployment naming.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Tool Definition File Format.
 */

const argumentTypeSchema = z.enum(['string', 'number', 'boolean', 'array', 'object']);

export const argumentSchema = z.object({
  type: argumentTypeSchema,
  description: z.string().min(1, { message: 'arg.description is required' }),
  optional: z.boolean().optional(),
});

const secretAliasSchema = z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]);

export const toolYamlSchema = z.object({
  description: z.string().min(1, { message: 'tool.yaml.description is required' }),
  args: z.record(z.string().min(1), argumentSchema).default({}),
  secrets: z.record(z.string().min(1), secretAliasSchema).default({}),
  name: z.string().min(1).optional(),
});

export type ArgumentType = z.infer<typeof argumentTypeSchema>;
export type ArgumentDef = z.infer<typeof argumentSchema>;
export type ToolYaml = z.infer<typeof toolYamlSchema>;

/**
 * Normalized secret declaration: canonical kwarg name plus the ordered list
 * of binding keys (env names registered with SECRETS_CONFIG) operators may
 * use to provide the value. `aliases` is non-empty by construction.
 */
export interface SecretSpecification {
  /** Kwarg name `invoke()` receives at dispatch time. */
  readonly canonical: string;
  /**
   * Binding keys to try, in order. The first one for which SecretManager
   * has a resolved value wins.
   */
  readonly aliases: readonly string[];
}

/**
 * Fully-resolved tool descriptor: the parsed `tool.yaml` plus the on-disk
 * location and the derived API-facing name.
 */
export interface ToolDescriptor {
  /** Absolute path to the tool's directory. Contains `tool.yaml` and `impl.py`. */
  readonly directory: string;
  /** Original dotted reference, preserved for error messages and diagnostics. */
  readonly reference: string;
  /**
   * API-facing tool name. Defaults to a derived form (e.g. `slack_post` from
   * `agency_tools/slack/post/`); overridden by `name:` in `tool.yaml` when set.
   */
  readonly name: string;
  readonly description: string;
  readonly args: Record<string, ArgumentDef>;
  readonly secrets: readonly SecretSpecification[];
}

/**
 * Derive the default API-facing name from a tool directory. Takes the last
 * two path segments to provide context: `agency_tools/slack/post/` becomes
 * `slack_post`. A flat root-level tool (`winston_agent/standalone/`) gets just
 * `standalone`.
 *
 * Tool authors can override this with `name:` in `tool.yaml` if a different
 * API-facing name is needed (e.g. to match an existing Anthropic tool name).
 */
export function computeToolName(directory: string): string {
  const segments = directory.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (segments.length < 2) return last;
  const parent = segments[segments.length - 2] ?? '';
  // Skip the parent if it's "tools" — common Python convention puts tools
  // under a tools/ subdir of the workspace package.
  if (parent === 'tools') return last;
  // Skip generic Python package roots so we don't end up with names like
  // `agency_tools_post` for `agency_tools/post/`.
  return `${parent}_${last}`;
}

/**
 * Normalize a `tool.yaml` `secrets:` map into an ordered list of SecretSpecification.
 * The YAML map's iteration order is preserved (js-yaml uses insertion order),
 * so authors who care about canonical-name ordering control it via the YAML.
 */
export function normalizeSecrets(raw: Record<string, string | string[]>): SecretSpecification[] {
  return Object.entries(raw).map(([canonical, aliasOrAliases]) => ({
    canonical,
    aliases: typeof aliasOrAliases === 'string' ? [aliasOrAliases] : [...aliasOrAliases],
  }));
}

/**
 * Build the JSON Schema fragment Clawndom registers with the Anthropic
 * tool-use API. `properties` keys map to the `args:` entries; `required`
 * contains every arg key WITHOUT `optional: true`.
 */
export function buildInputSchema(args: Record<string, ArgumentDef>): {
  type: 'object';
  properties: Record<string, { type: ArgumentType; description: string }>;
  required: string[];
} {
  const properties: Record<string, { type: ArgumentType; description: string }> = {};
  const required: string[] = [];
  for (const [argumentName, argumentSpec] of Object.entries(args)) {
    properties[argumentName] = { type: argumentSpec.type, description: argumentSpec.description };
    if (!argumentSpec.optional) required.push(argumentName);
  }
  return { type: 'object', properties, required };
}
