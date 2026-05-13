import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

const FIXTURE_DEFAULTS: Record<string, string> = {
  'identity/IDENTITY.md': '# T\n',
};

const trackedDirs: string[] = [];

/**
 * Materialize an on-disk fake agent workspace for an audit test. Files is a
 * map of relative path → body. The IDENTITY.md file is supplied by default so
 * the audit loader doesn't trip on a missing identity tier.
 *
 * The returned `agentDir` is auto-removed in the suite's afterEach hook.
 */
export async function buildAuditFixture(
  prefix: string,
  files: Record<string, string>,
): Promise<{ agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `clawndom-${prefix}-`));
  for (const [relativePath, body] of Object.entries({ ...FIXTURE_DEFAULTS, ...files })) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, body, 'utf-8');
  }
  trackedDirs.push(root);
  return { agentDir: root };
}

/**
 * Install reset + cleanup hooks for the calling test suite. Must be called at
 * the top of a describe block so the beforeEach/afterEach register against
 * the right suite.
 */
export function registerAuditFixtureHooks(): void {
  beforeEach(() => {
    trackedDirs.length = 0;
  });
  afterEach(async () => {
    for (const dir of trackedDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
