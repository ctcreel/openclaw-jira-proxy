import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import nunjucks from 'nunjucks';

import { isPlainObject } from '../extract';

// Body-level tags — content is inlined into the rendered user prompt.
const DOC_TAG_PATTERN = /\{\{doc:([^}]+)\}\}/g;
const SHARED_TAG_PATTERN = /\{\{shared:([^}]+)\}\}/g;

// System-prompt tags — content is extracted from the template body and
// returned separately as a system-prompt string. Same path-resolution shape
// as the body tags (agent dir vs shared dir), but the content lands in the
// system slot of the runner so it can be cached by Anthropic's prompt cache
// on each run. Stable content (IDENTITY, SOUL, anti-patterns, etc.) belongs
// here; per-event variable content stays in the body.
const SYSTEM_DOC_TAG_PATTERN = /\{\{system-doc:([^}]+)\}\}/g;
const SYSTEM_SHARED_TAG_PATTERN = /\{\{system-shared:([^}]+)\}\}/g;

async function readAgentDoc(agentDir: string, relativePath: string): Promise<string> {
  return await readFile(join(agentDir, relativePath), 'utf-8');
}

async function readSharedDoc(agentDir: string, relativePath: string): Promise<string> {
  // Shared docs live at <workspaces>/shared/<path>, i.e. one level up from the
  // agent workspace. We normalize the full path and require it to stay inside
  // that shared directory — no `..` escapes.
  const sharedRoot = resolve(dirname(agentDir), 'shared');
  const fullPath = resolve(sharedRoot, relativePath);
  if (fullPath !== sharedRoot && !fullPath.startsWith(`${sharedRoot}${sep}`)) {
    throw new Error(
      `Shared doc path escapes shared root: ${relativePath} -> ${fullPath} (root: ${sharedRoot})`,
    );
  }
  return await readFile(fullPath, 'utf-8');
}

interface SystemTagMatch {
  match: RegExpMatchArray;
  source: 'agent' | 'shared';
}

/**
 * Extract `{{system-doc:…}}` and `{{system-shared:…}}` tags from the template.
 * Returns the body with those tags removed (replaced by empty string) and the
 * collected system-prompt content in document order.
 *
 * Document order matters for cache reuse: Anthropic's prompt cache keys on
 * the prefix of the system block, so the same templates rendered with the
 * same `{{system-…}}` tags in the same order produce identical cacheable
 * prefixes. Reordering `{{system-…}}` tags between renders is a cache-bust.
 */
async function extractSystemTags(
  template: string,
  agentDir: string,
): Promise<{ body: string; systemContent: string }> {
  const docMatches = [...template.matchAll(SYSTEM_DOC_TAG_PATTERN)].map(
    (m): SystemTagMatch => ({ match: m, source: 'agent' }),
  );
  const sharedMatches = [...template.matchAll(SYSTEM_SHARED_TAG_PATTERN)].map(
    (m): SystemTagMatch => ({ match: m, source: 'shared' }),
  );

  if (docMatches.length === 0 && sharedMatches.length === 0) {
    return { body: template, systemContent: '' };
  }

  // Sort by index so concatenation order matches document order.
  const ordered = [...docMatches, ...sharedMatches].sort(
    (a, b) => (a.match.index ?? 0) - (b.match.index ?? 0),
  );

  const contents = await Promise.all(
    ordered.map(({ match, source }) =>
      source === 'shared'
        ? readSharedDoc(agentDir, match[1]!.trim())
        : readAgentDoc(agentDir, match[1]!.trim()),
    ),
  );

  let body = template;
  for (const { match } of ordered) {
    body = body.replace(match[0], '');
  }

  return { body, systemContent: contents.join('\n\n') };
}

async function preprocessDocTags(template: string, agentDir: string): Promise<string> {
  const docMatches = [...template.matchAll(DOC_TAG_PATTERN)];
  const sharedMatches = [...template.matchAll(SHARED_TAG_PATTERN)];
  if (docMatches.length === 0 && sharedMatches.length === 0) {
    return template;
  }

  const docContents = await Promise.all(
    docMatches.map((match) => readAgentDoc(agentDir, match[1]!.trim())),
  );
  const sharedContents = await Promise.all(
    sharedMatches.map((match) => readSharedDoc(agentDir, match[1]!.trim())),
  );

  let result = template;
  for (let index = 0; index < docMatches.length; index++) {
    result = result.replace(docMatches[index]![0], docContents[index]!);
  }
  for (let index = 0; index < sharedMatches.length; index++) {
    result = result.replace(sharedMatches[index]![0], sharedContents[index]!);
  }

  return result;
}

const nunjucksEnvironment = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

export interface RenderedTemplate {
  /**
   * Stable, cacheable content extracted from `{{system-doc:…}}` /
   * `{{system-shared:…}}` tags. Empty string if the template has no system
   * tags. Runners that support a separate system slot (e.g. `claude-cli`
   * via `--system-prompt`) MUST forward this here rather than inlining it
   * in the body — that's what enables prompt-cache reuse across runs.
   */
  systemPrompt: string;
  /**
   * The rendered template body — per-event variable content. Goes into
   * the user prompt (e.g. `claude -p <body>`).
   */
  body: string;
}

export interface IdentityInjection {
  /** Auto-prepend `{{system-doc:identity/IDENTITY.md}}`. Default true. */
  readonly identity?: boolean;
  /** Auto-prepend `{{system-doc:identity/SOUL.md}}`. Default true. */
  readonly soul?: boolean;
}

/**
 * Build the auto-prepended identity-tier injection lines for a rule. When
 * the caller doesn't pass an `identity` config (e.g. tests rendering a raw
 * template in isolation), no auto-injection happens — the rule loader is
 * the only place where the "default ON" semantics live. When the caller
 * DOES pass a config (worker.service / task-worker), the two injections
 * default to true and individual fields can be turned off.
 */
function buildIdentityPreamble(config: IdentityInjection | undefined): string {
  if (config === undefined) return '';
  const wantIdentity = config.identity ?? true;
  const wantSoul = config.soul ?? true;
  const lines: string[] = [];
  if (wantIdentity) lines.push('{{system-doc:identity/IDENTITY.md}}');
  if (wantSoul) lines.push('{{system-doc:identity/SOUL.md}}');
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n\n`;
}

export interface EntityRenderContext {
  actor?: unknown;
  entity_model?: string;
  interactions?: unknown[];
}

export async function renderTemplate(
  template: string,
  payload: unknown,
  baseDir: string,
  options: { identity?: IdentityInjection; entityContext?: EntityRenderContext } = {},
): Promise<RenderedTemplate> {
  const preamble = buildIdentityPreamble(options.identity);
  const effectiveTemplate = preamble + template;
  const { body: bodyAfterSystemExtraction, systemContent } = await extractSystemTags(
    effectiveTemplate,
    baseDir,
  );
  const bodyAfterDocTags = await preprocessDocTags(bodyAfterSystemExtraction, baseDir);

  const spreadable = isPlainObject(payload) ? payload : {};
  const context: Record<string, unknown> = {
    payload: JSON.stringify(payload, null, 2),
    ...spreadable,
    ...(options.entityContext ?? {}),
  };

  const body = nunjucksEnvironment.renderString(bodyAfterDocTags, context);
  // Render Nunjucks tags in the system content too — the per-agent
  // identity bits may reference variables (e.g. `{{ agentName }}`).
  const systemPrompt =
    systemContent.length > 0 ? nunjucksEnvironment.renderString(systemContent, context) : '';

  return { systemPrompt, body };
}
