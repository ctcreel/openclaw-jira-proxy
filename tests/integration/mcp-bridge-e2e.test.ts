import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  createMCPTestWorkspace,
  driveMCPServer,
  stageMCPFixtures,
  type MCPTestWorkspace,
  type MCPResponse,
} from './_mcp-test-harness';

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

describe('MCP bridge end-to-end (spawned Python server)', () => {
  let ws: MCPTestWorkspace;
  let toolConfigPath: string;
  let auditPath: string;

  beforeEach(async () => {
    ws = await createMCPTestWorkspace('spe-2078-e2e');
    ({ toolConfigPath, auditPath } = await stageMCPFixtures(ws.workDir, 'fixture_e2e_pkg', [
      {
        toolSegment: 'echo',
        apiName: 'fixture_echo',
        description: 'Echo a value and the first 4 chars of api_token',
        args: { value: { type: 'string', description: 'value to echo' } },
        secrets: [{ canonical: 'api_token', aliases: ['API_TOKEN'] }],
        implPy: `def invoke(*, value, api_token):
    return {"echoed": value, "token_head": api_token[:4]}
`,
      },
    ]));
  });

  afterEach(async () => {
    await ws.cleanup();
  });

  async function drive(frames: readonly object[]): Promise<MCPResponse[]> {
    const { responses, stderr } = await driveMCPServer({
      toolConfigPath,
      auditPath,
      workDir: ws.workDir,
      agentId: 'test-winston',
      routeId: 'slack-winston:chat',
      requestId: 'req-e2e-1',
      agentVersion: 'sha256:e2etest',
      toolCredentials: { fixture_echo: { api_token: 'super-secret-12345' } },
      frames,
    });
    if (responses.length === 0 && stderr.length > 0) {
      throw new Error(`MCP server emitted no responses. stderr: ${stderr}`);
    }
    return responses;
  }

  it('replies to initialize with protocol metadata', async () => {
    const responses = await drive([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      },
    ]);
    expect(responses).toHaveLength(1);
    const result = responses[0]?.result as InitializeResult | undefined;
    expect(result?.protocolVersion).toBe('2024-11-05');
    expect(result?.serverInfo.name).toBe('clawndom-tools');
    expect(result?.capabilities.tools).toBeDefined();
  });

  it('lists tools with input schemas derived from tool.yaml args', async () => {
    const responses = await drive([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
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
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'fixture_echo', arguments: { value: 'hello' } },
      },
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
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'fixture_echo',
          // Adversary stuffs the credential into the args:
          arguments: { value: 'super-secret-12345' },
        },
      },
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
  });
});
