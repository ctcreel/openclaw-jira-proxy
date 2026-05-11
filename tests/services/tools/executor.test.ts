import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCall } from '../../../src/services/tools/executor';
import {
  _resetAgentVersionCache,
  initializeAgentVersion,
} from '../../../src/services/version.service';
import type { ToolDescriptor } from '../../../src/services/tools/descriptor';

const AUDIT_FIXTURE_VERSION = 'sha256:test-version';

async function primeAgentVersion(repoPath: string): Promise<void> {
  // The executor calls getAgentVersion() to stamp records. We rely on a
  // real repo (the test repo) for the boot check; the helper uses the repo
  // path passed in.
  _resetAgentVersionCache();
  // Initialize against the workdir itself (not a real git repo); the test
  // doesn't care about the resulting hash, only that the cache is primed.
  // We accept the warning about no .git by using process.cwd() which IS a
  // git repo (clawndom checkout).
  await initializeAgentVersion([repoPath]);
}

describe('executeToolCall (bash)', () => {
  let workDir: string;
  let auditPath: string;
  let originalAuditEnv: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-executor-bash-'));
    auditPath = join(workDir, 'audit.log');
    originalAuditEnv = process.env['CLAWNDOM_AUDIT_LOG'];
    process.env['CLAWNDOM_AUDIT_LOG'] = auditPath;
    await primeAgentVersion(process.cwd());
  });

  afterEach(async () => {
    if (originalAuditEnv === undefined) delete process.env['CLAWNDOM_AUDIT_LOG'];
    else process.env['CLAWNDOM_AUDIT_LOG'] = originalAuditEnv;
    await rm(workDir, { recursive: true, force: true });
    _resetAgentVersionCache();
  });

  function makeBashDescriptor(): ToolDescriptor {
    return {
      kind: 'bash',
      directory: workDir,
      reference: 'pkg.tool',
      name: 'echo_tool',
      description: 'echo args',
      args: { value: { type: 'string', description: 'value to echo' } },
      requires: ['api_token'],
    };
  }

  it('dispatches a bash tool with args + credentials in scoped env', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      [
        '#!/usr/bin/env bash',
        '# Args: ARG_VALUE',
        '# Requires-Env: API_TOKEN',
        'set -euo pipefail',
        'TOKEN_FIRST4="${API_TOKEN:0:4}"',
        'printf \'%s\' "{\\"echoed\\": \\"$ARG_VALUE\\", \\"token_first4\\": \\"$TOKEN_FIRST4\\"}"',
        '',
      ].join('\n'),
    );
    await chmod(join(workDir, 'impl.sh'), 0o755);

    const result = await executeToolCall(
      { name: 'echo_tool', input: { value: 'hello' } },
      makeBashDescriptor(),
      { api_token: 'super-secret-12345' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-1' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ echoed: 'hello', token_first4: 'supe' });
  });

  it('writes exactly one audit record with credentials redacted', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
# Args: ARG_VALUE
# Requires-Env: API_TOKEN
set -euo pipefail
printf '%s' "{\\"ok\\": true}"
`,
    );
    await chmod(join(workDir, 'impl.sh'), 0o755);

    await executeToolCall(
      { name: 'echo_tool', input: { value: 'super-secret-12345' } }, // adversary stuffs the credential into args
      makeBashDescriptor(),
      { api_token: 'super-secret-12345' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-2' },
    );

    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as {
      args: { value: string };
      error_summary: unknown;
    };
    expect(record.args.value).toBe('<redacted>');
    expect(record.error_summary).toBeNull();
  });

  it('captures error_summary when the tool exits non-zero', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
echo "deliberate failure" >&2
exit 1
`,
    );
    await chmod(join(workDir, 'impl.sh'), 0o755);

    const result = await executeToolCall(
      { name: 'echo_tool', input: { value: 'x' } },
      makeBashDescriptor(),
      { api_token: 't' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-3' },
    );

    expect(result.isError).toBe(true);
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as { error_summary: string };
    expect(record.error_summary).toContain('deliberate failure');
  });
});

describe('executeToolCall (python)', () => {
  let workDir: string;
  let pkgDir: string;
  let auditPath: string;
  let originalAuditEnv: string | undefined;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-executor-py-'));
    // The wrapper does `importlib.import_module('test_pkg.tool.impl')`, so we
    // need a real Python package layout reachable via PYTHONPATH.
    pkgDir = join(workDir, 'test_pkg', 'tool');
    await rm(workDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(workDir, 'test_pkg', '__init__.py'), '');
    await writeFile(join(workDir, 'test_pkg', 'tool', '__init__.py'), '');
    await writeFile(
      join(pkgDir, 'impl.py'),
      `def invoke(*, value, api_token):
    return {"echoed": value, "token_first4": api_token[:4]}
`,
    );
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
    _resetAgentVersionCache();
  });

  it('dispatches a python tool with credentials as kwargs', async () => {
    const descriptor: ToolDescriptor = {
      kind: 'python',
      directory: pkgDir,
      reference: 'test_pkg.tool',
      name: 'test_tool',
      description: 'echo',
      args: { value: { type: 'string', description: 'v' } },
      requires: ['api_token'],
    };

    const result = await executeToolCall(
      { name: 'test_tool', input: { value: 'hi' } },
      descriptor,
      { api_token: 'super-secret-12345' },
      { agentId: 'winston', routeId: 'slack-winston', requestId: 'req-py-1' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ echoed: 'hi', token_first4: 'supe' });

    // Audit record present, credentials NOT in args (we passed only 'value').
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as {
      args: { value: string };
      tool_name: string;
      agent_version: string;
    };
    expect(record.tool_name).toBe('test_tool');
    expect(record.args.value).toBe('hi');
    expect(record.agent_version).toMatch(/^sha256:/);
  });
});
