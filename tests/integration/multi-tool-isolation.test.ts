import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Multi-tool credential isolation — regression guard for the contract
 * that each tool sees only its own credentials, never any other tool's,
 * even when the same MCP server instance dispatches both within a
 * session.
 *
 * A naive registry refactor (singleton, global, shared map) could merge
 * per-tool credentials. Auditors will ask "can tool A read tool B's
 * credential?" — this test answers it as a yes/no with a real round
 * trip.
 */

const TOKEN_A = 'tool-a-secret-1234567890-distinct-from-b';
const TOKEN_B = 'tool-b-secret-zyxwvutsrqp-distinct-from-a';

interface MCPResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface ToolsCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

const SERVER_SCRIPT = join(__dirname, '..', '..', 'scripts', 'clawndom_mcp_server.py');

describe('SPE-2078 multi-tool credential isolation', () => {
  let workDir: string;
  let toolConfigPath: string;
  let auditPath: string;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-isolation-'));

    // Two tools share the same impl file and behavior: each returns the
    // value it was passed plus a list of OTHER kwargs it received, so we
    // can spot any cross-contamination at the impl call boundary.
    const pkgRoot = join(workDir, 'iso_pkg');
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(join(pkgRoot, '__init__.py'), '');

    for (const toolName of ['tool_a', 'tool_b']) {
      const toolDir = join(pkgRoot, toolName);
      await mkdir(toolDir, { recursive: true });
      await writeFile(join(toolDir, '__init__.py'), '');
      await writeFile(
        join(toolDir, 'impl.py'),
        `def invoke(*, label, my_token):
    return {
        'label': label,
        'token_first_8': my_token[:8],
        'token_length': len(my_token),
    }
`,
      );
    }

    toolConfigPath = join(workDir, 'tool-config.json');
    await writeFile(
      toolConfigPath,
      JSON.stringify({
        tools: [
          {
            name: 'iso_tool_a',
            description: 'Tool A — should only see TOKEN_A',
            args: { label: { type: 'string', description: 'Echoed back' } },
            secrets: [{ canonical: 'my_token', aliases: ['ISO_TOKEN_A'] }],
            reference: 'iso_pkg.tool_a',
            directory: join(pkgRoot, 'tool_a'),
            inputSchema: {
              type: 'object',
              properties: { label: { type: 'string', description: 'Echoed back' } },
              required: ['label'],
            },
          },
          {
            name: 'iso_tool_b',
            description: 'Tool B — should only see TOKEN_B',
            args: { label: { type: 'string', description: 'Echoed back' } },
            secrets: [{ canonical: 'my_token', aliases: ['ISO_TOKEN_B'] }],
            reference: 'iso_pkg.tool_b',
            directory: join(pkgRoot, 'tool_b'),
            inputSchema: {
              type: 'object',
              properties: { label: { type: 'string', description: 'Echoed back' } },
              required: ['label'],
            },
          },
        ],
      }),
    );

    auditPath = join(workDir, 'audit.log');
    originalPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = `${workDir}:${originalPythonPath ?? ''}`;
  });

  afterEach(async () => {
    if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = originalPythonPath;
    await rm(workDir, { recursive: true, force: true });
  });

  async function driveBothTools(): Promise<{
    aResult: ToolsCallResult | undefined;
    bResult: ToolsCallResult | undefined;
    auditContents: string;
  }> {
    const credsFile = join(workDir, 'tool-creds.json');
    await writeFile(
      credsFile,
      JSON.stringify({
        iso_tool_a: { my_token: TOKEN_A },
        iso_tool_b: { my_token: TOKEN_B },
      }),
      { mode: 0o600 },
    );
    return new Promise((resolveResult, reject) => {
      const child = spawn('python3', [SERVER_SCRIPT, toolConfigPath], {
        env: {
          ...process.env,
          CLAWNDOM_AGENT_ID: 'iso-agent',
          CLAWNDOM_ROUTE_ID: 'iso-route',
          CLAWNDOM_REQUEST_ID: 'req-iso-probe',
          CLAWNDOM_AGENT_VERSION: 'sha256:isotest',
          CLAWNDOM_AUDIT_LOG: auditPath,
          CLAWNDOM_TOOL_CREDS_FILE: credsFile,
        },
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', async () => {
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as MCPResponse);
        const aResponse = lines.find((r) => r.id === 2)?.result as ToolsCallResult | undefined;
        const bResponse = lines.find((r) => r.id === 3)?.result as ToolsCallResult | undefined;
        let auditContents = '';
        try {
          auditContents = await readFile(auditPath, 'utf-8');
        } catch {
          auditContents = '';
        }
        resolveResult({ aResult: aResponse, bResult: bResponse, auditContents });
      });

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'iso_tool_a', arguments: { label: 'A-invocation' } },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'iso_tool_b', arguments: { label: 'B-invocation' } },
        })}\n`,
      );
      child.stdin.end();
    });
  }

  it("each tool sees only its own credential — never the other tool's", async () => {
    const { aResult, bResult } = await driveBothTools();
    expect(aResult, 'tool A must return a result').toBeDefined();
    expect(bResult, 'tool B must return a result').toBeDefined();
    expect(aResult?.isError).toBe(false);
    expect(bResult?.isError).toBe(false);

    const a = JSON.parse(aResult?.content[0]?.text ?? '') as {
      label: string;
      token_first_8: string;
      token_length: number;
    };
    const b = JSON.parse(bResult?.content[0]?.text ?? '') as {
      label: string;
      token_first_8: string;
      token_length: number;
    };

    // A sees TOKEN_A
    expect(a.label).toBe('A-invocation');
    expect(a.token_first_8).toBe(TOKEN_A.slice(0, 8));
    expect(a.token_length).toBe(TOKEN_A.length);

    // B sees TOKEN_B — different prefix AND different length than A
    expect(b.label).toBe('B-invocation');
    expect(b.token_first_8).toBe(TOKEN_B.slice(0, 8));
    expect(b.token_length).toBe(TOKEN_B.length);

    // Crucially: A's token first-8 chars and B's first-8 chars differ
    expect(a.token_first_8).not.toBe(b.token_first_8);
  });

  it("audit log redacts each tool's credential value independently", async () => {
    const { auditContents } = await driveBothTools();
    const lines = auditContents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    // Neither full credential appears anywhere in the audit log, even
    // though both invocations were captured in the same file.
    expect(auditContents).not.toContain(TOKEN_A);
    expect(auditContents).not.toContain(TOKEN_B);

    const recordA = JSON.parse(lines[0] ?? '') as { tool_name: string };
    const recordB = JSON.parse(lines[1] ?? '') as { tool_name: string };
    expect(recordA.tool_name).toBe('iso_tool_a');
    expect(recordB.tool_name).toBe('iso_tool_b');
  });
});
