import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
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
 *     with the provided credentials.
 *   - An audit record lands at CLAWNDOM_AUDIT_LOG with the expected
 *     fields, and credential values stuffed into args are redacted.
 *
 * Uses a fixture bash tool (no network), so the test is offline and
 * deterministic. The Slack helpers' Python path is exercised separately
 * in `tests/services/tools/executor.test.ts`.
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
  let toolDir: string;
  let toolConfigPath: string;
  let auditPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-e2e-'));

    // Set up a fixture bash tool that the MCP server can dispatch to.
    // Echoes ARG_VALUE plus the first 4 chars of API_TOKEN so we can
    // verify the credential made it into the subprocess env.
    toolDir = join(workDir, 'fixture_tool');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'impl.sh'),
      [
        '#!/usr/bin/env bash',
        '# Args: ARG_VALUE',
        '# Requires-Env: API_TOKEN',
        'set -euo pipefail',
        'TOKEN_HEAD="${API_TOKEN:0:4}"',
        'printf \'{"echoed":"%s","token_head":"%s"}\' "$ARG_VALUE" "$TOKEN_HEAD"',
        '',
      ].join('\n'),
    );
    await chmod(join(toolDir, 'impl.sh'), 0o755);

    toolConfigPath = join(workDir, 'tool-config.json');
    await writeFile(
      toolConfigPath,
      JSON.stringify({
        tools: [
          {
            name: 'fixture_echo',
            description: 'Echo a value and the first 4 chars of API_TOKEN',
            args: {
              value: { type: 'string', description: 'value to echo' },
            },
            requires: ['api_token'],
            kind: 'bash',
            reference: 'fixture',
            directory: toolDir,
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
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function drive(frames: readonly string[]): Promise<MCPResponse[]> {
    return new Promise((resolveFrames, reject) => {
      const child = spawn('python3', [SERVER_SCRIPT, toolConfigPath], {
        env: {
          ...process.env,
          CLAWNDOM_AGENT_ID: 'test-winston',
          CLAWNDOM_ROUTE_ID: 'slack-winston:chat',
          CLAWNDOM_REQUEST_ID: 'req-e2e-1',
          CLAWNDOM_AGENT_VERSION: 'sha256:e2etest',
          CLAWNDOM_AUDIT_LOG: auditPath,
          CLAWNDOM_TOOL_CREDS: JSON.stringify({
            fixture_echo: { api_token: 'super-secret-12345' },
          }),
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
    expect(tool?.inputSchema.properties.value).toMatchObject({ type: 'string' });
  });

  it('dispatches tools/call to the bash impl with credentials in env', async () => {
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
