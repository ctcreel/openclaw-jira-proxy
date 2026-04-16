import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

import { modelRuleSchema } from '../config';
import type { AgentEntry } from '../config';
import { getLogger } from '../lib/logging';
import { conditionSchema } from '../strategies/routing';

const execFile = promisify(execFileCallback);
const logger = getLogger('agent-loader');

const agentRuleSchema = z.object({
  name: z.string().optional(),
  condition: conditionSchema,
  messageTemplate: z.string().optional(),
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
  cloneOrPull(repoUrl: string, cloneDir: string, ref?: string): Promise<void>;
}

export const defaultGitClient: GitClient = {
  async cloneOrPull(repoUrl, cloneDir, ref) {
    if (!existsSync(cloneDir)) {
      logger.info({ repoUrl, cloneDir }, 'Cloning agent repo');
      await execFile('git', ['clone', repoUrl, cloneDir]);
    } else {
      logger.debug({ cloneDir }, 'Fetching latest for agent repo');
      await execFile('git', ['-C', cloneDir, 'fetch', '--prune']);
    }
    if (ref !== undefined) {
      await execFile('git', ['-C', cloneDir, 'reset', '--hard', `origin/${ref}`]);
    } else {
      await execFile('git', ['-C', cloneDir, 'pull', '--ff-only']);
    }
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

    const agentDir = entry.path === undefined ? cloneDir : join(cloneDir, entry.path);
    const configPath = join(agentDir, 'clawndom.yaml');
    const rawYaml = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(rawYaml);
    const config = agentConfigSchema.parse(parsed);

    resolved.push({ name: entry.name, dir: agentDir, config });
  }

  return resolved;
}
