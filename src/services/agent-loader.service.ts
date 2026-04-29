import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

import { modelRuleSchema } from '../config';
import type { AgentEntry, SharedToolsConfig } from '../config';
import { getLogger } from '../lib/logging';
import { conditionSchema } from '../strategies/routing';
import { listSessionKeyStrategies, sessionConfigSchema } from '../strategies/session-key';

const execFile = promisify(execFileCallback);
const logger = getLogger('agent-loader');

// Rules are shared across providers, but `routing.schedule` rules carry
// extra fields (cron + timezone + catchUp + context) and don't need a
// `condition`. Validating the per-provider invariants — schedule rules
// have a cron, condition rules have a condition — happens in the
// schedulers/workers that consume the rules, not at parse time. This
// keeps the schema flat and the type one shape across providers.
const agentRuleSchema = z.object({
  name: z.string().optional(),
  condition: conditionSchema.optional(),
  messageTemplate: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  catchUp: z.boolean().optional().default(false),
  context: z.record(z.string(), z.unknown()).optional(),
  /**
   * Opt-in session-aware runner mode. When present, events matching this
   * rule dispatch through the SessionPool (warm subprocess + Redis-backed
   * session_id resume) instead of the per-event-spawn path. NOT supported
   * on `routing.schedule` rules — each scheduled run is a snapshot.
   */
  session: sessionConfigSchema.optional(),
});

const agentRoutingSchema = z.object({
  rules: z.array(agentRuleSchema).default([]),
});

const agentConfigSchema = z.object({
  routing: z.record(z.string(), agentRoutingSchema).default({}),
  modelRules: z.record(z.string(), z.array(modelRuleSchema)).default({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentRule = z.infer<typeof agentRuleSchema>;

export interface ResolvedAgent {
  readonly name: string;
  readonly dir: string;
  readonly config: AgentConfig;
}

export interface GitClient {
  /**
   * Branch-tracking clone. Fast-forwards when no `ref` is supplied; resets to
   * `origin/<ref>` when supplied. Branch semantics — pinned tag/SHA refs go
   * through `clonePinned` instead.
   */
  cloneOrPull(repoUrl: string, cloneDir: string, ref?: string): Promise<void>;
  /**
   * Pinned-ref clone. Fetches all refs (including tags) and resets to the
   * given tag or commit SHA. Throws if the ref does not exist in the remote
   * — fail-fast over silent drift.
   */
  clonePinned(repoUrl: string, cloneDir: string, ref: string): Promise<void>;
}

export const defaultGitClient: GitClient = {
  async cloneOrPull(repoUrl, cloneDir, ref) {
    if (existsSync(cloneDir)) {
      logger.debug({ cloneDir }, 'Fetching latest for agent repo');
      await execFile('git', ['-C', cloneDir, 'fetch', '--prune']);
    } else {
      logger.info({ repoUrl, cloneDir }, 'Cloning agent repo');
      await execFile('git', ['clone', repoUrl, cloneDir]);
    }
    if (ref === undefined) {
      await execFile('git', ['-C', cloneDir, 'pull', '--ff-only']);
    } else {
      await execFile('git', ['-C', cloneDir, 'reset', '--hard', `origin/${ref}`]);
    }
  },

  async clonePinned(repoUrl, cloneDir, ref) {
    if (!existsSync(cloneDir)) {
      logger.info({ repoUrl, cloneDir }, 'Cloning shared-tools repo');
      await execFile('git', ['clone', repoUrl, cloneDir]);
    }
    logger.debug({ cloneDir, ref }, 'Resetting shared-tools repo to pinned ref');
    // No `origin/` prefix: tags and commit SHAs aren't namespaced under
    // remote-tracking refs. `--prune --tags` ensures local tags match the
    // remote so a tag-only ref resolves on reset.
    await execFile('git', ['-C', cloneDir, 'fetch', '--prune', '--tags', 'origin']);
    await execFile('git', ['-C', cloneDir, 'reset', '--hard', ref]);
  },
};

/**
 * Local directory name for a cloned repo. Collision-safe across providers
 * because it includes the org/owner plus the repo name.
 */
export function slugifyRepoUrl(repoUrl: string): string {
  const withoutSuffix = repoUrl.replace(/\.git$/, '');
  const parts = withoutSuffix.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Cannot derive clone directory from repo URL: ${repoUrl}`);
  }
  return parts.slice(-2).join('__');
}

export async function loadAgents(
  entries: readonly AgentEntry[],
  configDir: string,
  git: GitClient = defaultGitClient,
): Promise<ResolvedAgent[]> {
  await mkdir(configDir, { recursive: true });

  const cloneByRepo = new Map<string, string>();
  // Tracks which sharedTools spec each agent repo committed to. Two agents
  // sharing an agent repo (e.g. patch + scarlett in `the-agency`) share the
  // same shared-tools clone dir, so they must agree on (repo, ref, path).
  const sharedToolsByRepo = new Map<string, SharedToolsConfig>();
  const resolved: ResolvedAgent[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate agent name in AGENTS_CONFIG: ${entry.name}`);
    }
    seenNames.add(entry.name);

    let cloneDir = cloneByRepo.get(entry.repo);
    if (cloneDir === undefined) {
      cloneDir = join(configDir, slugifyRepoUrl(entry.repo));
      await git.cloneOrPull(entry.repo, cloneDir, entry.ref);
      cloneByRepo.set(entry.repo, cloneDir);
    }

    if (entry.sharedTools !== undefined) {
      const previous = sharedToolsByRepo.get(entry.repo);
      if (previous === undefined) {
        const sharedDir = join(cloneDir, entry.sharedTools.path);
        await git.clonePinned(entry.sharedTools.repo, sharedDir, entry.sharedTools.ref);
        sharedToolsByRepo.set(entry.repo, entry.sharedTools);
      } else if (
        previous.repo !== entry.sharedTools.repo ||
        previous.ref !== entry.sharedTools.ref ||
        previous.path !== entry.sharedTools.path
      ) {
        throw new Error(
          `Conflicting sharedTools for agent repo ${entry.repo}: ` +
            `previously declared ${JSON.stringify(previous)}, ` +
            `agent ${entry.name} declared ${JSON.stringify(entry.sharedTools)}`,
        );
      }
    }

    const agentDir = entry.path === undefined ? cloneDir : join(cloneDir, entry.path);
    const configPath = join(agentDir, 'clawndom.yaml');
    const rawYaml = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(rawYaml);
    const config = agentConfigSchema.parse(parsed);

    validateSessionConfig(entry.name, config);

    resolved.push({ name: entry.name, dir: agentDir, config });
  }

  return resolved;
}

/**
 * Cross-cuts that Zod can't catch at parse time:
 *  - `session` is forbidden on `routing.schedule.rules[*]` because each
 *    scheduled run is a snapshot — conversational continuity is meaningless.
 *  - `session.strategy` must reference a registered SessionKeyStrategy.
 *
 * Throws on the first violation with a message identifying the offending
 * agent and rule. Failing fast at startup is preferable to discovering the
 * issue when the first event arrives.
 */
function validateSessionConfig(agentName: string, config: AgentConfig): void {
  const knownStrategies = new Set(listSessionKeyStrategies());
  for (const [providerName, providerRouting] of Object.entries(config.routing)) {
    for (const rule of providerRouting.rules) {
      if (rule.session === undefined) continue;
      const ruleLabel = rule.name ?? '<unnamed>';
      if (providerName === 'schedule') {
        throw new Error(
          `Agent ${agentName}: routing.schedule rule "${ruleLabel}" declares session — schedule rules do not support session-aware runners.`,
        );
      }
      if (!knownStrategies.has(rule.session.strategy)) {
        throw new Error(
          `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}" declares unknown session.strategy "${rule.session.strategy}". Known strategies: ${Array.from(knownStrategies).join(', ') || '<none>'}.`,
        );
      }
    }
  }
}
