import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end integration test for the SPE-2078 MCP bridge.
 *
 * Spawns the real `scripts/clawndom_mcp_server.py` via stdio, drives it
 * with MCP JSON-RPC frames (initialize → tools/list → tools/call), and
 * verifies:
 *   - The server replies with the expected protocol version + tools list.
 *   - The tools list mirrors the input config's `args`/`required` shape.
 *   - A `tools/call` dispatches to the real Python helper, invoking it
 *     with the provided credentials as kwargs.
 *   - An audit record lands at CLAWNDOM_AUDIT_LOG with the expected
 *     fields, and credential values stuffed into args are redacted.
 */

interface MCPResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools?: object };
  serverInfo: { name: string; version: string };
}

interface ToolsListResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
  }>;
}

interface ToolsCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

interface AuditRecord {
  agent_id: string;
  route_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  result_summary: unknown;
  error_summary: string | null;
  request_id: string;
  correlation_id: string;
  agent_version: string;
}

const SERVER_SCRIPT = join(__dirname, '..', '..', 'scripts', 'clawndom_mcp_server.py');

describe('MCP bridge end-to-end (spawned Python server)', () => {
  let workDir: string;
  let pkgDir: string;
  let toolConfigPath: string;
  let auditPath: string;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-e2e-'));

    // Stage a Python fixture tool that echoes its value plus the first 4
    // chars of the credential, so we can verify the credential reached the
    // impl via kwargs.
    pkgDir = join(workDir, 'fixture_e2e_pkg', 'echo');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(workDir, 'fixture_e2e_pkg', '__init__.py'), '');
    await writeFile(join(pkgDir, '__init__.py'), '');
    await writeFile(
      join(pkgDir, 'impl.py'),
      `def invoke(*, value, api_token):
    return {"echoed": value, "token_head": api_token[:4]}
`,
    );

    toolConfigPath = join(workDir, 'tool-config.json');
    await writeFile(
      toolConfigPath,
      JSON.stringify({
        tools: [
          {
            name: 'fixture_echo',
            description: 'Echo a value and the first 4 chars of api_token',
            args: {
              value: { type: 'string', description: 'value to echo' },
            },
            secrets: [{ canonical: 'api_token', aliases: ['API_TOKEN'] }],
            reference: 'fixture_e2e_pkg.echo',
            directory: pkgDir,
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string', description: 'value to echo' } },
              required: ['value'],
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

  async function drive(frames: readonly string[]): Promise<MCPResponse[]> {
    const credsFile = join(workDir, 'tool-creds.json');
    await writeFile(
      credsFile,
      JSON.stringify({ fixture_echo: { api_token: 'super-secret-12345' } }),
      { mode: 0o600 },
    );
    return new Promise((resolveFrames, reject) => {
      const child = spawn('python3', [SERVER_SCRIPT, toolConfigPath], {
        env: {
          ...process.env,
          CLAWNDOM_AGENT_ID: 'test-winston',
          CLAWNDOM_ROUTE_ID: 'slack-winston:chat',
          CLAWNDOM_REQUEST_ID: 'req-e2e-1',
          CLAWNDOM_AGENT_VERSION: 'sha256:e2etest',
          CLAWNDOM_AUDIT_LOG: auditPath,
          CLAWNDOM_TOOL_CREDS_FILE: credsFile,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', () => {
        const responses = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as MCPResponse);
        if (responses.length === 0 && stderr.length > 0) {
          reject(new Error(`MCP server emitted no responses. stderr: ${stderr}`));
        } else {
          resolveFrames(responses);
        }
      });
      for (const frame of frames) {
        child.stdin.write(`${frame}\n`);
      }
      child.stdin.end();
    });
  }

  it('replies to initialize with protocol metadata', async () => {
    const responses = await drive([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      }),
    ]);
    expect(responses).toHaveLength(1);
    const result = responses[0]?.result as InitializeResult | undefined;
    expect(result?.protocolVersion).toBe('2024-11-05');
    expect(result?.serverInfo.name).toBe('clawndom-tools');
    expect(result?.capabilities.tools).toBeDefined();
  });

  it('lists tools with input schemas derived from tool.yaml args', async () => {
    const responses = await drive([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ]);
    const list = responses.find((r) => r.id === 2)?.result as ToolsListResult | undefined;
    expect(list?.tools).toHaveLength(1);
    const tool = list?.tools[0];
    expect(tool?.name).toBe('fixture_echo');
    expect(tool?.inputSchema.required).toEqual(['value']);
    expect(tool?.inputSchema.properties['value']).toMatchObject({ type: 'string' });
  });

  it('dispatches tools/call to the python impl with credentials as kwargs', async () => {
    const responses = await drive([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'fixture_echo',
          arguments: { value: 'hello' },
        },
      }),
    ]);
    const call = responses.find((r) => r.id === 2)?.result as ToolsCallResult | undefined;
    expect(call?.isError).toBe(false);
    const inner = JSON.parse(call?.content[0]?.text ?? '') as {
      echoed: string;
      token_head: string;
    };
    expect(inner.echoed).toBe('hello');
    expect(inner.token_head).toBe('supe'); // first 4 chars of "super-secret-12345"
  });

  it('writes an audit record with credentials redacted from args', async () => {
    await drive([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'fixture_echo',
          // Adversary stuffs the credential into the args:
          arguments: { value: 'super-secret-12345' },
        },
      }),
    ]);

    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as AuditRecord;

    expect(record.agent_id).toBe('test-winston');
    expect(record.route_id).toBe('slack-winston:chat');
    expect(record.tool_name).toBe('fixture_echo');
    expect(record.request_id).toBe('req-e2e-1');
    expect(record.correlation_id).toBe('req-e2e-1');
    expect(record.agent_version).toBe('sha256:e2etest');
    expect(record.args).toEqual({ value: '<redacted>' });
    // The literal credential value must NOT appear anywhere in the record:
    expect(JSON.stringify(record)).not.toContain('super-secret-12345');
  });
});
