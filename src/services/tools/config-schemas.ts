import { z } from 'zod';

/**
 * Route-side declaration of agent-callable tools. Each entry in a routing
 * rule's `tools:` list uses the key `module.python:` with a dotted
 * import-path reference to the tool's directory. Dots resolve to directory
 * separators at boot; the final directory MUST contain `tool.yaml` and
 * `impl.py`.
 *
 * Schema is extensible to additional `module.<lang>:` keys (e.g. `module.rust:`)
 * by adding a new variant to the union and registering an executor.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`.
 */

// Python module names must be valid Python identifiers per segment (letters,
// digits, underscores; no hyphens). The leading character of each segment
// must be a letter or underscore.
const PYTHON_DOTTED_REF = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export const toolRefSchema = z
  .object({
    'module.python': z.string().regex(PYTHON_DOTTED_REF, {
      message:
        'Python tool reference must be a dotted path of identifiers (letters/digits/underscores only; no hyphens).',
    }),
  })
  .strict();

export const ruleToolsSchema = z.array(toolRefSchema);

export type ToolRef = z.infer<typeof toolRefSchema>;
export type RuleTools = z.infer<typeof ruleToolsSchema>;

/**
 * Extract the dotted reference string from a tool entry.
 */
export function getToolReference(ref: ToolRef): string {
  return ref['module.python'];
}
