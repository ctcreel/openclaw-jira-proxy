import { z } from 'zod';

/**
 * Route-side declaration of agent-callable tools. Each entry in a routing
 * rule's `tools:` list is exactly one of `module.python:` or `module.bash:`
 * with a dotted reference to the tool's directory. Dots resolve to directory
 * separators at boot; the final directory MUST contain `tool.yaml`.
 *
 * Schema is extensible to additional `module.<lang>:` keys (e.g. `module.rust:`)
 * by registering a new executor and adding a variant here.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`.
 */

// Python module names must be valid Python identifiers per segment (letters,
// digits, underscores; no hyphens). The leading character of each segment
// must be a letter or underscore.
const PYTHON_DOTTED_REF = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

// Bash directory names may additionally include hyphens within segments.
// Leading character of each segment is still a letter or underscore.
const BASH_DOTTED_REF = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

export const pythonToolRefSchema = z
  .object({
    'module.python': z.string().regex(PYTHON_DOTTED_REF, {
      message:
        'Python tool reference must be a dotted path of identifiers (letters/digits/underscores only; no hyphens).',
    }),
  })
  .strict();

export const bashToolRefSchema = z
  .object({
    'module.bash': z.string().regex(BASH_DOTTED_REF, {
      message:
        'Bash tool reference must be a dotted path of identifiers (letters/digits/underscores/hyphens).',
    }),
  })
  .strict();

/**
 * One entry in a rule's `tools:` list. Exactly one of the two keys MUST be
 * present; `.strict()` on each branch rejects extra keys, so a `{module.python,
 * module.bash}` entry fails both branches and the union rejects it.
 */
export const toolRefSchema = z.union([pythonToolRefSchema, bashToolRefSchema]);

export const ruleToolsSchema = z.array(toolRefSchema);

export type PythonToolRef = z.infer<typeof pythonToolRefSchema>;
export type BashToolRef = z.infer<typeof bashToolRefSchema>;
export type ToolRef = z.infer<typeof toolRefSchema>;
export type RuleTools = z.infer<typeof ruleToolsSchema>;

export type ToolKind = 'python' | 'bash';

/**
 * Discriminate between the two tool kinds at runtime. The schema is a Zod
 * union of `.strict()` objects, so the type is a tagged-by-presence union.
 */
export function getToolKind(ref: ToolRef): ToolKind {
  return 'module.python' in ref ? 'python' : 'bash';
}

/**
 * Extract the dotted reference string from a tool entry, regardless of kind.
 */
export function getToolReference(ref: ToolRef): string {
  return 'module.python' in ref ? ref['module.python'] : ref['module.bash'];
}
