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

  /**
   * Stage an impl.py, run executeToolCall with the standard test descriptor,
   * and read back the single audit record. Used by every failure-mode test
   * (raises, non-JSON, slow, truncation) so the test bodies stay focused on
   * the assertion that differs.
   */
  async function runWithImpl(
    implPy: string,
    requestId: string,
    opts: { input?: Record<string, unknown>; timeoutMs?: number } = {},
  ): Promise<{ result: Awaited<ReturnType<typeof executeToolCall>>; record: AuditRecordShape }> {
    await writeFile(join(pkgDir, 'impl.py'), implPy);
    const result = await executeToolCall(
      { name: 'test_tool', input: opts.input ?? { value: 'x' } },
      makeDescriptor(),
      { api_token: 't' },
      { agentId: 'winston', routeId: 'slack-winston', requestId },
      opts.timeoutMs,
    );
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as AuditRecordShape;
    return { result, record };
  }

  interface AuditRecordShape {
    error_summary: string | null;
    result_summary: unknown;
    agent_version: string;
    args: Record<string, unknown>;
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

  it('captures error_summary when the impl raises', async () => {
    const { result, record } = await runWithImpl(
      `def invoke(*, value, api_token):\n    raise RuntimeError("deliberate failure")\n`,
      'req-3',
    );
    expect(result.isError).toBe(true);
    expect(record.error_summary).toContain('deliberate failure');
  });

  it('captures non-JSON stdout as an error', async () => {
    const { result, record } = await runWithImpl(
      `def invoke(*, value, api_token):\n    import sys; sys.stdout.write("not json at all")\n    return None\n`,
      'req-bad-json',
    );
    expect(result.isError).toBe(true);
    expect(record.error_summary).toMatch(/non-JSON stdout/);
  });

  it('truncates very long string result_summary in the audit record', async () => {
    const { record } = await runWithImpl(
      `def invoke(*, value, api_token):\n    return "x" * 5000\n`,
      'req-4',
    );
    const summary = record.result_summary as string;
    expect(summary.length).toBeLessThan(5000);
    expect(summary).toContain('[truncated]');
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
    const { result, record } = await runWithImpl(
      `def invoke(*, value, api_token):\n    import time; time.sleep(5)\n    return {}\n`,
      'req-5',
      { timeoutMs: 500 },
    );
    expect(result.isError).toBe(true);
    expect(record.error_summary).toMatch(/timed out/);
  });
});
