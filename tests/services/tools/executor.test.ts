import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCall } from '../../../src/services/tools/executor';
import {
  resetAgentVersionCacheForTests,
  initializeAgentVersion,
} from '../../../src/services/version.service';
import type { ToolDescriptor } from '../../../src/services/tools/descriptor';

async function primeAgentVersion(repoPath: string): Promise<void> {
  resetAgentVersionCacheForTests();
  await initializeAgentVersion([repoPath]);
}

describe('executeToolCall', () => {
  let workDir: string;
  let pkgDir: string;
  let auditPath: string;
  let originalAuditEnv: string | undefined;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-executor-py-'));
    pkgDir = join(workDir, 'test_pkg', 'tool');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(workDir, 'test_pkg', '__init__.py'), '');
    await writeFile(join(workDir, 'test_pkg', 'tool', '__init__.py'), '');
    auditPath = join(workDir, 'audit.log');
    originalAuditEnv = process.env['CLAWNDOM_AUDIT_LOG'];
    process.env['CLAWNDOM_AUDIT_LOG'] = auditPath;
    originalPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = `${workDir}:${originalPythonPath ?? ''}`;
    await primeAgentVersion(process.cwd());
  });

  afterEach(async () => {
    if (originalAuditEnv === undefined) delete process.env['CLAWNDOM_AUDIT_LOG'];
    else process.env['CLAWNDOM_AUDIT_LOG'] = originalAuditEnv;
    if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = originalPythonPath;
    await rm(workDir, { recursive: true, force: true });
    resetAgentVersionCacheForTests();
  });

  function makeDescriptor(): ToolDescriptor {
    return {
      directory: pkgDir,
      reference: 'test_pkg.tool',
      name: 'test_tool',
      description: 'echo a value and the first 4 chars of api_token',
      args: { value: { type: 'string', description: 'v' } },
      secrets: [{ canonical: 'api_token', aliases: ['API_TOKEN'] }],
    };
  }

  async function writeEchoImpl(): Promise<void> {
    await writeFile(
      join(pkgDir, 'impl.py'),
      `def invoke(*, value, api_token):
    return {"echoed": value, "token_first4": api_token[:4]}
`,
    );
  }

  it('dispatches with credentials as kwargs (not env)', async () => {
    await writeEchoImpl();
    const result = await executeToolCall(
      { name: 'test_tool', input: { value: 'hi' } },
      makeDescriptor(),
      { api_token: 'super-secret-12345' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-1' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ echoed: 'hi', token_first4: 'supe' });
  });

  it('writes exactly one audit record with credentials redacted from args', async () => {
    await writeEchoImpl();
    await executeToolCall(
      // adversary stuffs the credential into the args
      { name: 'test_tool', input: { value: 'super-secret-12345' } },
      makeDescriptor(),
      { api_token: 'super-secret-12345' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-2' },
    );

    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as {
      args: { value: string };
      error_summary: unknown;
      agent_version: string;
    };
    expect(record.args.value).toBe('<redacted>');
    expect(record.error_summary).toBeNull();
    expect(record.agent_version).toMatch(/^sha256:/);
  });

  it('redacts a credential echoed back in the result_summary', async () => {
    await writeFile(
      join(pkgDir, 'impl.py'),
      `def invoke(*, value, api_token):
    return {"echoed_secret": api_token}
`,
    );
    await executeToolCall(
      { name: 'test_tool', input: { value: 'x' } },
      makeDescriptor(),
      { api_token: 'super-secret-12345' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-leak' },
    );

    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as {
      result_summary: { echoed_secret: string };
    };
    expect(record.result_summary.echoed_secret).toBe('<redacted>');
  });

  it.each([
    {
      label: 'captures error_summary when the impl raises',
      impl: `def invoke(*, value, api_token):
    raise RuntimeError("deliberate failure")
`,
      requestId: 'req-3',
      errorSummary: /deliberate failure/,
    },
    {
      label: 'captures non-JSON stdout as an error',
      impl: `def invoke(*, value, api_token):
    import sys; sys.stdout.write("not json at all")
    return None
`,
      requestId: 'req-bad-json',
      errorSummary: /non-JSON stdout/,
    },
  ])('$label', async ({ impl, requestId, errorSummary }) => {
    await writeFile(join(pkgDir, 'impl.py'), impl);

    const result = await executeToolCall(
      { name: 'test_tool', input: { value: 'x' } },
      makeDescriptor(),
      { api_token: 't' },
      { agentId: 'winston', routeId: 'slack-winston', requestId },
    );

    expect(result.isError).toBe(true);
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as { error_summary: string };
    expect(record.error_summary).toMatch(errorSummary);
  });

  it('truncates very long string result_summary in the audit record', async () => {
    await writeFile(
      join(pkgDir, 'impl.py'),
      `def invoke(*, value, api_token):
    return "x" * 5000
`,
    );

    await executeToolCall(
      { name: 'test_tool', input: { value: 'x' } },
      makeDescriptor(),
      { api_token: 't' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-4' },
    );
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as { result_summary: string };
    expect(record.result_summary.length).toBeLessThan(5000);
    expect(record.result_summary).toContain('[truncated]');
  });

  it('leaves structured result_summary unchanged (no truncation marker)', async () => {
    await writeEchoImpl();
    await executeToolCall(
      { name: 'test_tool', input: { value: 'short' } },
      makeDescriptor(),
      // api_token chosen so its first 4 chars do not equal the credential
      // itself — otherwise the result_summary's `token_first4` would be
      // redacted (correctly), and we'd be testing redaction, not truncation.
      { api_token: 'longer-token-value' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-obj' },
    );
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as {
      result_summary: { echoed: string; token_first4: string };
    };
    expect(record.result_summary).toEqual({ echoed: 'short', token_first4: 'long' });
  });

  it('captures a spawn-error when the impl module is unimportable', async () => {
    const result = await executeToolCall(
      { name: 'test_tool', input: { value: 'x' } },
      makeDescriptor(),
      { api_token: 't' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-spawnerr' },
    );
    expect(result.isError).toBe(true);
  });

  it('times out a slow tool with a clear error', async () => {
    await writeFile(
      join(pkgDir, 'impl.py'),
      `def invoke(*, value, api_token):
    import time; time.sleep(5)
    return {}
`,
    );

    const result = await executeToolCall(
      { name: 'test_tool', input: { value: 'x' } },
      makeDescriptor(),
      { api_token: 't' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-5' },
      500,
    );

    expect(result.isError).toBe(true);
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as { error_summary: string };
    expect(record.error_summary).toMatch(/timed out/);
  });
});
