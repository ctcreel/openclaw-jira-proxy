import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';

import { getLogger } from '../lib/logging';
import { agentConfigSchema } from '../services/agent-loader.service';
import type { AgentConfig, ResolvedAgent } from '../services/agent-loader.service';

const logger = getLogger('system-agent-loader');

const SYSTEM_AGENTS_DIR = 'src/system-agents';

/**
 * Load clawndom's bundled system agents from `src/system-agents/<name>/`.
 * Each subdirectory containing a `clawndom.yaml` is a system agent.
 * Returns ResolvedAgent records shaped identically to those produced by
 * the external-agent loader — system agents flow through the same worker
 * + runner machinery once loaded.
 *
 * Unlike `loadAgents`, this does not clone anything, does not support
 * `sharedTools`, and reads from the running clawndom source tree at
 * `process.cwd()/src/system-agents/`.
 */
export async function loadSystemAgents(): Promise<ResolvedAgent[]> {
  const baseDir = join(process.cwd(), SYSTEM_AGENTS_DIR);
  const entries = await readdir(baseDir, { withFileTypes: true });
  const resolved: ResolvedAgent[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentDir = join(baseDir, entry.name);
    const configPath = join(agentDir, 'clawndom.yaml');
    if (!(await isFilePresent(configPath))) continue;

    const config = await readAndParseConfig(configPath);
    resolved.push({ name: entry.name, dir: agentDir, config });
    logger.info({ name: entry.name, dir: agentDir }, 'System agent loaded');
  }

  return resolved;
}

async function isFilePresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    // Only ENOENT means "not present"; surface permission/IO errors so a
    // misconfigured deployment doesn't silently skip a system agent.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readAndParseConfig(path: string): Promise<AgentConfig> {
  const rawYaml = await readFile(path, 'utf-8');
  const parsed = parseYaml(rawYaml);
  return agentConfigSchema.parse(parsed);
}
