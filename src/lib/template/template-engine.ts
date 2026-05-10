import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import nunjucks from 'nunjucks';

import { parseFrontmatter, type TemplateFrontmatter } from './frontmatter';
import { renderToolBlock } from './render-tool-block';

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
// {{tools}} placeholder (single, no payload). Treated as a system-slot tag in
// document order alongside `{{system-doc:…}}` / `{{system-shared:…}}` — its
// content is the rendered Markdown block produced from the template's
// frontmatter `tools:` manifest. See `render-tool-block.ts`.
const TOOLS_TAG_PATTERN = /\{\{tools\}\}/g;

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
  source: 'agent' | 'shared' | 'tools';
}

interface ExtractSystemTagsArgs {
  template: string;
  agentDir: string;
  frontmatter: TemplateFrontmatter;
  rawFrontmatter: string;
  agencyToolsPath: string | undefined;
}

/**
 * Extract `{{system-doc:…}}`, `{{system-shared:…}}`, and `{{tools}}` tags
 * from the template. Returns the body with those tags removed (replaced by
 * empty string) and the collected system-prompt content in document order.
 *
 * Document order matters for cache reuse: Anthropic's prompt cache keys on
 * the prefix of the system block, so the same templates rendered with the
 * same `{{system-…}}` tags in the same order produce identical cacheable
 * prefixes. Reordering tags between renders is a cache-bust.
 *
 * `{{tools}}` is single (no path argument) and resolves to the rendered
 * Markdown block produced from `frontmatter.tools` against the agent's
 * shared-tools clone path. Templates that don't declare frontmatter `tools:`
 * but include `{{tools}}` would render an empty block — boot-time validation
 * (`validate-tool-templates.ts`) rejects that misconfig before this path
 * runs, so we treat it here as render-empty rather than throwing.
 */
async function extractSystemTags(
  args: ExtractSystemTagsArgs,
): Promise<{ body: string; systemContent: string }> {
  const { template, agentDir, frontmatter, rawFrontmatter, agencyToolsPath } = args;

  const docMatches = [...template.matchAll(SYSTEM_DOC_TAG_PATTERN)].map(
    (m): SystemTagMatch => ({ match: m, source: 'agent' }),
  );
  const sharedMatches = [...template.matchAll(SYSTEM_SHARED_TAG_PATTERN)].map(
    (m): SystemTagMatch => ({ match: m, source: 'shared' }),
  );
  const toolsMatches = [...template.matchAll(TOOLS_TAG_PATTERN)].map(
    (m): SystemTagMatch => ({ match: m, source: 'tools' }),
  );

  if (docMatches.length === 0 && sharedMatches.length === 0 && toolsMatches.length === 0) {
    return { body: template, systemContent: '' };
  }

  // Sort by index so concatenation order matches document order.
  const ordered = [...docMatches, ...sharedMatches, ...toolsMatches].sort(
    (a, b) => (a.match.index ?? 0) - (b.match.index ?? 0),
  );

  const contents = await Promise.all(
    ordered.map(({ match, source }) => {
      if (source === 'shared') return readSharedDoc(agentDir, match[1]!.trim());
      if (source === 'agent') return readAgentDoc(agentDir, match[1]!.trim());
      return resolveToolBlockContent(frontmatter, rawFrontmatter, agencyToolsPath);
    }),
  );

  let body = template;
  for (const { match } of ordered) {
    body = body.replace(match[0], '');
  }

  return { body, systemContent: contents.join('\n\n') };
}

async function resolveToolBlockContent(
  frontmatter: TemplateFrontmatter,
  rawFrontmatter: string,
  agencyToolsPath: string | undefined,
): Promise<string> {
  if (frontmatter.tools.length === 0) {
    // Validation rejects {{tools}} without a `tools:` manifest at boot. If
    // we still reach here (e.g. a template loaded outside the validator's
    // agent walk in tests), render empty rather than throw — the empty
    // body is harmless and the byte-stability invariant still holds.
    return '';
  }
  if (agencyToolsPath === undefined) {
    // Same rationale: validation forbids declaring `tools:` without a
    // matching `sharedTools` entry on the agent. Reaching this branch
    // means the template was rendered outside the validator, so we
    // surface an explicit error rather than silently dropping content.
    throw new Error(
      'Template declares `tools:` in frontmatter but no agencyToolsPath was provided to ' +
        'renderTemplate(). Wire `sharedTools` on the agent so the worker can pass it.',
    );
  }
  return await renderToolBlock({
    tools: frontmatter.tools,
    agencyToolsPath,
    rawFrontmatter,
  });
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
   * Stable, cacheable content extracted from `{{system-doc:…}}`,
   * `{{system-shared:…}}`, and `{{tools}}` tags. Empty string if the
   * template has no system tags. Runners that support a separate system
   * slot (e.g. `claude-cli` via `--system-prompt`) MUST forward this here
   * rather than inlining it in the body — that's what enables prompt-cache
   * reuse across runs.
   */
  systemPrompt: string;
  /**
   * The rendered template body — per-event variable content. Goes into
   * the user prompt (e.g. `claude -p <body>`).
   */
  body: string;
}

export interface RenderTemplateOptions {
  /**
   * Filesystem path to the agent's shared-tools clone (e.g. agency-tools).
   * Required when the template's frontmatter declares `tools:`; ignored
   * otherwise. Boot validation rejects templates that declare `tools:`
   * without a matching `sharedTools` entry, so this is normally always
   * supplied for tool-declaring templates.
   */
  agencyToolsPath?: string;
}

export async function renderTemplate(
  template: string,
  payload: unknown,
  baseDir: string,
  options: RenderTemplateOptions = {},
): Promise<RenderedTemplate> {
  // Frontmatter is parsed first (and stripped) so downstream tag
  // extraction never sees its `---` fences as document content. A
  // template without an opening fence flows through unchanged with an
  // empty `tools:` manifest.
  const { frontmatter, body: bodyAfterFrontmatter, rawFrontmatter } = parseFrontmatter(template);

  const { body: bodyAfterSystemExtraction, systemContent } = await extractSystemTags({
    template: bodyAfterFrontmatter,
    agentDir: baseDir,
    frontmatter,
    rawFrontmatter,
    agencyToolsPath: options.agencyToolsPath,
  });
  const bodyAfterDocTags = await preprocessDocTags(bodyAfterSystemExtraction, baseDir);

  const spreadable = typeof payload === 'object' && payload !== null ? payload : {};
  const context = {
    payload: JSON.stringify(payload, null, 2),
    ...spreadable,
  };

  const body = nunjucksEnvironment.renderString(bodyAfterDocTags, context);
  // Render Nunjucks tags in the system content too — the per-agent
  // identity bits may reference variables (e.g. `{{ agentName }}`).
  // Tool blocks already render as plain Markdown without Nunjucks
  // expressions, so this pass is a no-op for the tool-block portion.
  const systemPrompt =
    systemContent.length > 0 ? nunjucksEnvironment.renderString(systemContent, context) : '';

  return { systemPrompt, body };
}
