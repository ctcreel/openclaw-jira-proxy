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
 *
 * The optional `templates` map seeds template files referenced by the
 * yamlBody. The boot-time audit refuses to start an agent whose routes
 * declare templates that don't exist on disk; tests that exercise a real
 * `clawndom.yaml` must satisfy that contract.
 */
export async function writeAgentRepo(
  fakeRemotes: string,
  slug: string,
  yamlBody: string,
  templates: Record<string, string> = {},
): Promise<void> {
  const repoRoot = join(fakeRemotes, slug);
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, 'clawndom.yaml'), yamlBody, 'utf-8');
  for (const [relativePath, body] of Object.entries(templates)) {
    const fullPath = join(repoRoot, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, body, 'utf-8');
  }
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
