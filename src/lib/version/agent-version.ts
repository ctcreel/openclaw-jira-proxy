import { createHash } from 'node:crypto';

import { captureRepoVersion, type RepoVersion } from './git';

/**
 * Deterministic composite version identifier for the running agent's behavior.
 * Composed by sorting involved repositories by name, hashing each as
 * `name:sha\n` lines, and taking sha256 of the concatenation.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-versioning/spec.md`,
 * Requirement: Composite Agent Version Hash.
 */

export interface RepoInput {
  /** Canonical name used for sorting and per-repo breakdown. */
  readonly name: string;
  /** Filesystem path. Must contain a `.git` directory. */
  readonly path: string;
}

export interface RepoEntry {
  readonly name: string;
  readonly sha: string;
  readonly dirty: boolean;
}

export interface AgentVersion {
  readonly hash: string;
  readonly repos: readonly RepoEntry[];
}

export async function computeAgentVersion(repos: readonly RepoInput[]): Promise<AgentVersion> {
  const captured: Array<{ name: string; version: RepoVersion }> = [];
  for (const repo of repos) {
    const version = await captureRepoVersion(repo.path);
    captured.push({ name: repo.name, version });
  }
  captured.sort((a, b) => a.name.localeCompare(b.name));
  const serialized = captured.map((r) => `${r.name}:${r.version.sha}\n`).join('');
  const hash = createHash('sha256').update(serialized).digest('hex');
  return {
    hash: `sha256:${hash}`,
    repos: captured.map((r) => ({ name: r.name, sha: r.version.sha, dirty: r.version.dirty })),
  };
}

/**
 * Returns the list of dirty repo names from an `AgentVersion`. Empty array
 * if everything is clean.
 */
export function dirtyRepos(version: AgentVersion): string[] {
  return version.repos.filter((r) => r.dirty).map((r) => r.name);
}
