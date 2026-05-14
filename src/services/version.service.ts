import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { getLogger } from '../lib/logging';
import {
  computeAgentVersion,
  listDirtyRepos,
  type AgentVersion,
  type RepoInput,
} from '../lib/version/agent-version';

const logger = getLogger('version');

let cached: AgentVersion | undefined;

/**
 * Initialize the cached agent_version hash at boot. Walks the agent
 * directories to discover their containing repositories, plus the Clawndom
 * checkout itself. In `CLAWNDOM_ENV=production`, throws if any involved
 * repository is dirty.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-versioning/spec.md`.
 */
export async function initializeAgentVersion(
  agentDirs: readonly string[],
  clawndomCheckout: string = process.cwd(),
): Promise<AgentVersion> {
  const repos = await findRepos(agentDirs, clawndomCheckout);
  const version = await computeAgentVersion(repos);

  const dirty = listDirtyRepos(version);
  if (dirty.length > 0) {
    logger.warn(
      { repos: dirty, hash: version.hash },
      'Repos have uncommitted changes; agent_version reflects the committed SHAs only',
    );
  }

  if (process.env['CLAWNDOM_ENV'] === 'production' && dirty.length > 0) {
    throw new Error(
      `CLAWNDOM_ENV=production but the following repositories have uncommitted changes: ${dirty.join(', ')}. ` +
        `Commit and tag a release before booting in production mode.`,
    );
  }

  cached = version;
  logger.info(
    { hash: version.hash, repos: version.repos.map((r) => r.name) },
    'agent_version computed',
  );
  return version;
}

/**
 * Return the cached agent_version. Throws if `initializeAgentVersion` hasn't
 * been called yet.
 */
export function getAgentVersion(): AgentVersion {
  if (cached === undefined) {
    throw new Error('getAgentVersion() called before initializeAgentVersion(); fix boot sequence');
  }
  return cached;
}

/** For tests only. */
export function resetAgentVersionCacheForTests(): void {
  cached = undefined;
}

/**
 * Discover unique git repository roots involved in the running configuration.
 * Walks up from each agent directory to find `.git`; dedupes by canonical
 * repo path; includes the Clawndom checkout.
 */
async function findRepos(
  agentDirs: readonly string[],
  clawndomCheckout: string,
): Promise<RepoInput[]> {
  const seen = new Map<string, RepoInput>();

  const clawndomRoot = await findRepoRoot(clawndomCheckout);
  if (clawndomRoot !== undefined) {
    seen.set(clawndomRoot, { name: computeRepoName(clawndomRoot), path: clawndomRoot });
  }

  for (const agentDir of agentDirs) {
    const root = await findRepoRoot(agentDir);
    if (root === undefined) continue;
    if (!seen.has(root)) {
      seen.set(root, { name: computeRepoName(root), path: root });
    }
  }

  // Also scan for sibling shared-tool clones (e.g. agency-tools cloned by
  // the agent-loader as a sibling directory of an agent workspace). Each
  // such sibling that contains a `.git` directory is its own repo.
  for (const agentDir of agentDirs) {
    await findSiblingRepos(agentDir, seen);
  }

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function findRepoRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  // Walk up until we either find a `.git` directory or hit the filesystem root.
  // The fixed upper bound (path segment count) plus the parent-equals-current
  // check guarantees termination.
  for (let depth = 0; depth < 200; depth++) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

async function findSiblingRepos(agentDir: string, seen: Map<string, RepoInput>): Promise<void> {
  // Two scan locations cover the sharedTools placements clawndom uses:
  //
  //   1. **Inside** the agent's repo root — clawndom's `clonePinned` places
  //      sharedTools at `<cloneDir>/<sharedTools.path>/`, where cloneDir IS
  //      the agent's repo. So agency-tools lives at e.g.
  //      `winston-agency/agency-tools/`. Walk one level down.
  //   2. **Beside** the agent's repo root — for layouts where the operator
  //      clones sharedTools as a sibling rather than nested.
  //
  // Both scans dedupe via `seen`, so a repo found by both passes only counts
  // once. Limiting to depth 1 keeps the scan O(direct entries).
  const repoRoot = await findRepoRoot(agentDir);
  if (repoRoot === undefined) return;
  await findNestedGitDirs(repoRoot, seen);
  await findNestedGitDirs(dirname(repoRoot), seen);
}

async function findNestedGitDirs(parentDir: string, seen: Map<string, RepoInput>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = join(parentDir, entry);
    if (seen.has(candidate)) continue;
    try {
      const s = await stat(candidate);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(candidate, '.git'))) {
      seen.set(candidate, { name: computeRepoName(candidate), path: candidate });
    }
  }
}

function computeRepoName(repoPath: string): string {
  // Use the directory basename for the repo name. This is what `agent_version`
  // serializes in its hash; sibling repos with the same basename would collide
  // but in practice each repo lives under a unique parent path.
  const segments = repoPath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? repoPath;
}
