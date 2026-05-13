import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { auditAgent, type AuditReport } from '../src/audit';

const FIXTURE_DEFAULTS: Record<string, string> = {
  'identity/IDENTITY.md': '# T\n',
};

const trackedDirs: string[] = [];

/**
 * Audit-test harness bound to a describe block. Each test calls
 * `audit(files)` with the per-test fixture content; the helper writes
 * the file tree to a tmpdir, invokes `auditAgent`, and the suite's
 * afterEach cleans the tmpdir up.
 *
 * The per-test-file boilerplate this replaced (an import of
 * `buildAuditFixture` + a local `makeFixture` wrapper that bound the
 * prefix) was Sonar-flagged as duplicated tokens across every audit
 * check's test file. Consolidating the wiring here removes the source
 * of that duplication.
 */
export interface AuditHarness {
  audit(files: Record<string, string>): Promise<AuditReport>;
}

export function useAuditHarness(): AuditHarness {
  beforeEach(() => {
    trackedDirs.length = 0;
  });
  afterEach(async () => {
    for (const dir of trackedDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });
  return {
    async audit(files: Record<string, string>): Promise<AuditReport> {
      const agentDir = await materialize(files);
      return auditAgent(agentDir);
    },
  };
}

async function materialize(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clawndom-audit-'));
  for (const [relativePath, body] of Object.entries({ ...FIXTURE_DEFAULTS, ...files })) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, body, 'utf-8');
  }
  trackedDirs.push(root);
  return root;
}

/**
 * Lower-level helper for tests that need the workspace materialized
 * but invoke something other than `auditAgent` against it (e.g. the
 * graph renderer's tests). Audit tests should prefer `useAuditHarness`.
 */
export async function materializeWorkspace(
  files: Record<string, string>,
): Promise<{ agentDir: string }> {
  return { agentDir: await materialize(files) };
}

export function registerWorkspaceCleanup(): void {
  beforeEach(() => {
    trackedDirs.length = 0;
  });
  afterEach(async () => {
    for (const dir of trackedDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
