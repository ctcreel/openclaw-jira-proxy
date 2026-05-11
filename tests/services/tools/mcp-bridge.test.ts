import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildMCPRunFiles } from '../../../src/services/tools/mcp-bridge';
import type { ToolDescriptor } from '../../../src/services/tools/descriptor';
import {
  resetAgentVersionCacheForTests,
  initializeAgentVersion,
} from '../../../src/services/version.service';

describe('buildMCPRunFiles', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-mcp-bridge-'));
    resetAgentVersionCacheForTests();
    await initializeAgentVersion([process.cwd()]);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    resetAgentVersionCacheForTests();
  });

  function makeDescriptor(): ToolDescriptor {
    return {
      kind: 'python',
      directory: workDir,
      reference: 'fixture.tool',
      name: 'fixture_tool',
      description: 'A fixture',
      args: {
        channel: { type: 'string', description: 'channel' },
        text: { type: 'string', description: 'text' },
        thread_ts: { type: 'string', description: 'thread', optional: true },
      },
      requires: ['bot_token'],
    };
  }

  it('writes mcp-config.json and tool-config.json with mode 0o600', async () => {
    const files = await buildMCPRunFiles(
      [makeDescriptor()],
      { perTool: { fixture_tool: { bot_token: 'xoxb-test' } } },
      { agentId: 'a', routeId: 'r', requestId: 'req-1' },
    );
    const mcp = JSON.parse(await readFile(files.mcpConfigPath, 'utf-8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['clawndom-tools']);
    expect(mcp.mcpServers['clawndom-tools']?.command).toBe('python3');
    expect(mcp.mcpServers['clawndom-tools']?.args[0]).toMatch(/clawndom_mcp_server\.py$/);
    expect(mcp.mcpServers['clawndom-tools']?.args[1]).toBe(files.toolConfigPath);
  });

  it('writes tool-config with descriptors + derived input schema', async () => {
    const files = await buildMCPRunFiles(
      [makeDescriptor()],
      { perTool: { fixture_tool: { bot_token: 'xoxb' } } },
      { agentId: 'a', routeId: 'r', requestId: 'req-2' },
    );
    const tools = JSON.parse(await readFile(files.toolConfigPath, 'utf-8')) as {
      tools: Array<{
        name: string;
        inputSchema: { required: string[]; properties: Record<string, unknown> };
      }>;
    };
    expect(tools.tools).toHaveLength(1);
    const tool = tools.tools[0];
    expect(tool?.name).toBe('fixture_tool');
    expect(tool?.inputSchema.required).toEqual(['channel', 'text']);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      'channel',
      'text',
      'thread_ts',
    ]);
  });

  it('env contains credentials JSON, identifiers, and agent_version', async () => {
    const files = await buildMCPRunFiles(
      [makeDescriptor()],
      { perTool: { fixture_tool: { bot_token: 'xoxb-actual' } } },
      {
        agentId: 'winston',
        routeId: 'slack-winston:chat',
        requestId: 'req-abc',
        correlationId: 'corr-xyz',
      },
    );
    expect(files.env['CLAWNDOM_AGENT_ID']).toBe('winston');
    expect(files.env['CLAWNDOM_ROUTE_ID']).toBe('slack-winston:chat');
    expect(files.env['CLAWNDOM_REQUEST_ID']).toBe('req-abc');
    expect(files.env['CLAWNDOM_CORRELATION_ID']).toBe('corr-xyz');
    expect(files.env['CLAWNDOM_AGENT_VERSION']).toMatch(/^sha256:/);
    expect(JSON.parse(files.env['CLAWNDOM_TOOL_CREDS'] ?? '{}')).toEqual({
      fixture_tool: { bot_token: 'xoxb-actual' },
    });
  });

  it('defaults correlation_id to request_id when not provided', async () => {
    const files = await buildMCPRunFiles(
      [makeDescriptor()],
      { perTool: { fixture_tool: { bot_token: 'x' } } },
      { agentId: 'a', routeId: 'r', requestId: 'req-only' },
    );
    expect(files.env['CLAWNDOM_CORRELATION_ID']).toBe('req-only');
  });

  it('places config files in a per-run temp directory', async () => {
    const a = await buildMCPRunFiles(
      [makeDescriptor()],
      { perTool: { fixture_tool: { bot_token: 'x' } } },
      { agentId: 'a', routeId: 'r', requestId: 'req-A' },
    );
    const b = await buildMCPRunFiles(
      [makeDescriptor()],
      { perTool: { fixture_tool: { bot_token: 'x' } } },
      { agentId: 'a', routeId: 'r', requestId: 'req-B' },
    );
    expect(dirname(a.mcpConfigPath)).not.toBe(dirname(b.mcpConfigPath));
    await rm(dirname(a.mcpConfigPath), { recursive: true, force: true });
    await rm(dirname(b.mcpConfigPath), { recursive: true, force: true });
  });
});
