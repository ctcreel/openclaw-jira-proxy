import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { slugifyRepoUrl, type GitClient } from '../../src/services/agent-loader.service';
import type { AgentEntry } from '../../src/config';

/**
 * Recursively copies a directory tree. Used by test fixtures to simulate
 * git clone by copying a pre-seeded "remote" directory into the clone target.
 */
export async function copyTree(src: string, dest: string): Promise<void> {
  const { readdir, copyFile, stat } = await import('node:fs/promises');
  const entries = await readdir(src);
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const info = await stat(s);
    if (info.isDirectory()) {
      await copyTree(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

/**
 * Returns a GitClient stub that "clones" by copying from fakeRemotes.
 */
export function makeFakeGit(fakeRemotes: string): GitClient {
  return {
    async cloneOrPull(repoUrl: string, cloneDir: string): Promise<void> {
      const source = join(fakeRemotes, slugifyRepoUrl(repoUrl));
      await mkdir(cloneDir, { recursive: true });
      await copyTree(source, cloneDir);
    },
    async clonePinned(): Promise<void> {},
  };
}

/**
 * Writes a minimal agent repo (clawndom.yaml) under fakeRemotes/<slug>.
 */
export async function writeAgentRepo(
  fakeRemotes: string,
  slug: string,
  yamlBody: string,
): Promise<void> {
  const repoRoot = join(fakeRemotes, slug);
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, 'clawndom.yaml'), yamlBody, 'utf-8');
}

/**
 * Creates an AgentEntry for testing.
 */
export function entry(name: string, slug: string): AgentEntry {
  return {
    name,
    repo: `git@github.com:SC0RED/${slug}.git`,
  };
}
