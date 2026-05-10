import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedAgent } from '../../services/agent-loader.service';
import type { SecretManager } from '../../secrets/manager';
import { getLogger } from '../logging';
import { parseFrontmatter, templateHasToolsPlaceholder } from './frontmatter';
import { validateToolModulesImport } from './render-tool-block';

const logger = getLogger('validate-tool-templates');

interface ToolTemplateValidationFailure {
  readonly agent: string;
  readonly template: string;
  readonly reason: string;
}

/**
 * Walk every agent's routing rules, parse each `messageTemplate` for YAML
 * frontmatter, and validate the `tools:` manifest against:
 *
 *   1. Placeholder/declaration consistency — declarations require a
 *      `{{tools}}` placeholder in the body, and a placeholder requires
 *      declarations. (Either alone is a misconfig — the rendered prompt
 *      would silently drop content the author meant to include.)
 *   2. Secret resolution — every `requires_env` entry must be a known
 *      `SecretManager` key (declared in `SECRETS_CONFIG`).
 *   3. Module importability — every declared `module` must `import_module`
 *      cleanly under the agent's resolved agency-tools path.
 *
 * Failures aggregate; we throw a single Error listing every offender so a
 * misconfigured deploy doesn't burn through "fix one, learn the next" cycles.
 *
 * Skipped silently:
 *   - Agents with no routing rules.
 *   - Rules with no `messageTemplate` (schedule rules that just dispatch
 *     a task; no template to inspect).
 *   - Templates with no frontmatter or empty `tools:` (no work to do).
 */
export async function validateToolTemplates(
  agents: readonly ResolvedAgent[],
  secretManager: SecretManager,
  agencyToolsPathByAgent: ReadonlyMap<string, string>,
): Promise<void> {
  const failures: ToolTemplateValidationFailure[] = [];

  // Track unique (agencyToolsPath, modules) pairs so we run one introspector
  // call per path rather than spawning Python once per template.
  const modulesByPath = new Map<string, Set<string>>();

  for (const agent of agents) {
    await collectAgentValidations(
      agent,
      agencyToolsPathByAgent,
      secretManager,
      failures,
      modulesByPath,
    );
  }

  await runImportValidations(modulesByPath, failures);

  if (failures.length > 0) {
    const details = failures.map((f) => `${f.agent} :: ${f.template} — ${f.reason}`).join('\n  - ');
    throw new Error(`Template tool manifest validation failed:\n  - ${details}`);
  }

  if (modulesByPath.size > 0) {
    logger.info(
      {
        agents: agents.length,
        agencyToolsPaths: modulesByPath.size,
        modules: [...modulesByPath.values()].reduce((sum, set) => sum + set.size, 0),
      },
      'Tool-template manifests validated',
    );
  }
}

async function collectAgentValidations(
  agent: ResolvedAgent,
  agencyToolsPathByAgent: ReadonlyMap<string, string>,
  secretManager: SecretManager,
  failures: ToolTemplateValidationFailure[],
  modulesByPath: Map<string, Set<string>>,
): Promise<void> {
  const templates = collectMessageTemplates(agent);
  if (templates.length === 0) return;

  const agencyToolsPath = agencyToolsPathByAgent.get(agent.name);

  for (const templateRelative of templates) {
    const templatePath = join(agent.dir, templateRelative);
    let raw: string;
    try {
      raw = await readFile(templatePath, 'utf-8');
    } catch (error) {
      failures.push({
        agent: agent.name,
        template: templateRelative,
        reason: `cannot read template: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(raw);
    } catch (error) {
      failures.push({
        agent: agent.name,
        template: templateRelative,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const hasPlaceholder = templateHasToolsPlaceholder(parsed.body);
    const declares = parsed.frontmatter.tools.length > 0;

    if (declares && !hasPlaceholder) {
      failures.push({
        agent: agent.name,
        template: templateRelative,
        reason:
          'frontmatter declares `tools:` but the body has no `{{tools}}` placeholder — ' +
          'the rendered docs would never appear in the prompt',
      });
      continue;
    }
    if (!declares && hasPlaceholder) {
      failures.push({
        agent: agent.name,
        template: templateRelative,
        reason:
          'body uses `{{tools}}` but the frontmatter declares no `tools:` — ' +
          'the placeholder would render to empty',
      });
      continue;
    }
    if (!declares) continue;

    if (agencyToolsPath === undefined) {
      failures.push({
        agent: agent.name,
        template: templateRelative,
        reason:
          'frontmatter declares `tools:` but the agent has no `sharedTools` configured — ' +
          'add a `sharedTools` entry to AGENTS_CONFIG so the introspector can resolve modules',
      });
      continue;
    }

    for (const tool of parsed.frontmatter.tools) {
      for (const envKey of tool.requires_env) {
        if (!secretManager.hasSecret(envKey)) {
          failures.push({
            agent: agent.name,
            template: templateRelative,
            reason: `module ${tool.module} declares requires_env "${envKey}" but it is not registered in SECRETS_CONFIG`,
          });
        }
      }
      let modulesForPath = modulesByPath.get(agencyToolsPath);
      if (modulesForPath === undefined) {
        modulesForPath = new Set();
        modulesByPath.set(agencyToolsPath, modulesForPath);
      }
      modulesForPath.add(tool.module);
    }
  }
}

async function runImportValidations(
  modulesByPath: ReadonlyMap<string, Set<string>>,
  failures: ToolTemplateValidationFailure[],
): Promise<void> {
  for (const [agencyToolsPath, moduleSet] of modulesByPath) {
    try {
      await validateToolModulesImport([...moduleSet], agencyToolsPath);
    } catch (error) {
      failures.push({
        agent: '<introspector>',
        template: agencyToolsPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Collect all `messageTemplate` paths declared across an agent's routing
 * rules. Deduplicated — the same template can be referenced by multiple
 * routing rules (one per provider) and we only need to validate it once.
 */
function collectMessageTemplates(agent: ResolvedAgent): string[] {
  const seen = new Set<string>();
  for (const providerRouting of Object.values(agent.config.routing)) {
    for (const rule of providerRouting.rules) {
      if (rule.messageTemplate !== undefined) {
        seen.add(rule.messageTemplate);
      }
    }
  }
  return [...seen];
}
