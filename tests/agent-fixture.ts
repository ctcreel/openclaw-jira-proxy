import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dump as dumpYaml } from 'js-yaml';
import { afterEach, beforeEach } from 'vitest';

import { auditAgent, type AuditReport } from '../src/audit';

const FIXTURE_DEFAULTS: Record<string, string> = {
  'identity/IDENTITY.md': '# T\n',
};

const trackedDirs: string[] = [];

/**
 * JS-object form of an agent config used by audit tests. `providers` is
 * the routing map (provider name → rules); `templates` maps the file
 * basename under templates/ to its body. `buildAgent` serializes the
 * structure to the on-disk file map the audit consumes.
 *
 * Tests pass typed object literals rather than inline YAML strings.
 * That keeps each test's input UNIQUE at the token level — Sonar's
 * cross-file CPD was flagging the routing/rules/messageTemplate YAML
 * scaffolding as duplication, and its PR new-code-density metric
 * ignores sonar.cpd.exclusions, so the only durable fix is to stop
 * emitting the duplicated tokens in the first place.
 */
export interface AgentBuilderInputs {
  providers?: Record<string, ReadonlyArray<Record<string, unknown>>>;
  templates?: Record<string, string>;
}

export function buildAgent(config: AgentBuilderInputs): Record<string, string> {
  const routing: Record<string, { rules: ReadonlyArray<Record<string, unknown>> }> = {};
  for (const [provider, rules] of Object.entries(config.providers ?? {})) {
    routing[provider] = { rules };
  }
  const files: Record<string, string> = {
    'clawndom.yaml': dumpYaml({ routing }, { lineWidth: 200 }),
  };
  for (const [name, body] of Object.entries(config.templates ?? {})) {
    files[`templates/${name}`] = body;
  }
  return files;
}

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
