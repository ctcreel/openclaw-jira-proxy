import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

/**
 * Optional YAML frontmatter that template authors write at the top of a
 * `.md` template, between two `---` fences. Today the only declared key
 * is `tools:` — the manifest of Python helpers whose canonical docs the
 * renderer should expand under the `{{tools}}` placeholder.
 *
 * The schema is `.strict()` on purpose: a misnamed top-level key is
 * exactly the failure mode this ticket exists to prevent. Silently
 * tolerating `tool:` (singular typo) or `requires-env` (kebab vs. snake)
 * would produce a quietly empty render and a quietly mis-cached prompt.
 * Fail at boot, name the bad key.
 */
export const toolEntrySchema = z
  .object({
    /**
     * Importable dotted path of the Python helper module
     * (e.g. `agency_tools.slack.post`). The introspector will
     * `importlib.import_module(<this>)` and walk its public callables.
     */
    module: z.string().min(1),
    /**
     * Logical secret keys (matching `SECRETS_CONFIG` entries) the helper
     * needs in its environment. Boot validation rejects names not
     * resolvable via `SecretManager`. Each key is upper-snake-cased into
     * an env var by the convention shared with `provider.envSecrets`.
     */
    requires_env: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ToolEntry = z.infer<typeof toolEntrySchema>;

export const frontmatterSchema = z
  .object({
    tools: z.array(toolEntrySchema).default([]),
  })
  .strict();

export type TemplateFrontmatter = z.infer<typeof frontmatterSchema>;

const FRONTMATTER_FENCE = '---';

export interface ParsedFrontmatter {
  /** Frontmatter parsed against the schema. Empty `tools` when no fence is present. */
  readonly frontmatter: TemplateFrontmatter;
  /** Template content with the frontmatter block (and trailing newline) stripped. */
  readonly body: string;
  /**
   * Raw frontmatter YAML text (between fences, no fences) when present, else
   * empty string. The renderer hashes this for cache-key construction so two
   * templates with byte-identical frontmatter share a rendered tool block.
   */
  readonly rawFrontmatter: string;
}

/**
 * Detect and parse leading YAML frontmatter on a template. Templates without
 * a `^---` opening fence are returned unchanged with an empty frontmatter
 * object — pre-existing templates keep working without modification.
 *
 * Detection rule: the very first line of the template must be exactly `---`.
 * Anything else (a blank line, a Markdown heading, an inline mustache tag)
 * means "no frontmatter" — we never go fishing for fences mid-document.
 *
 * Closing fence: the next `---` line. If the template opens a fence and
 * never closes it, that's a malformed template and we throw — better than
 * silently treating the whole body as YAML.
 */
export function parseFrontmatter(template: string): ParsedFrontmatter {
  if (!template.startsWith(`${FRONTMATTER_FENCE}\n`) && template !== FRONTMATTER_FENCE) {
    return {
      frontmatter: frontmatterSchema.parse({}),
      body: template,
      rawFrontmatter: '',
    };
  }

  const afterOpen = template.slice(FRONTMATTER_FENCE.length + 1); // strip "---\n"
  // Two close-fence cases:
  //   (a) `---\nbody` immediately after the opening fence — empty frontmatter
  //   (b) `…content…\n---\nbody` — populated frontmatter
  // Case (a) has no leading `\n` before the closing `---`, so the
  // `\n---` search misses it. Handle it explicitly first.
  let rawFrontmatter: string;
  let afterClose: string;
  if (afterOpen.startsWith(`${FRONTMATTER_FENCE}\n`) || afterOpen === FRONTMATTER_FENCE) {
    rawFrontmatter = '';
    afterClose = afterOpen.slice(FRONTMATTER_FENCE.length);
  } else {
    const closeIndex = afterOpen.indexOf(`\n${FRONTMATTER_FENCE}`);
    if (closeIndex === -1) {
      throw new Error(
        'Template opens a YAML frontmatter fence (`---`) but never closes it. ' +
          'Add a matching `---` line after the frontmatter.',
      );
    }
    rawFrontmatter = afterOpen.slice(0, closeIndex);
    // Skip the closing fence and the newline that follows it (if any).
    afterClose = afterOpen.slice(closeIndex + 1 + FRONTMATTER_FENCE.length);
  }
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawFrontmatter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Template frontmatter is not valid YAML: ${message}`);
  }

  // js-yaml parses an empty document as `undefined`. Treat that as "no fields"
  // rather than feeding `undefined` into the strict schema (which would reject).
  const yamlObject = parsedYaml === null || parsedYaml === undefined ? {} : parsedYaml;
  const frontmatter = frontmatterSchema.parse(yamlObject);

  return { frontmatter, body, rawFrontmatter };
}

/**
 * `true` iff the template body contains a `{{tools}}` placeholder. Used by
 * boot validation to enforce the "declarations <-> placeholder" invariant:
 * declaring `tools:` without `{{tools}}` (or vice versa) is a misconfig that
 * fails at startup rather than rendering an empty or never-rendered block.
 */
export function templateHasToolsPlaceholder(body: string): boolean {
  return /\{\{tools\}\}/.test(body);
}
