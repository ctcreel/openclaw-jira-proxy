import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  createMCPTestWorkspace,
  driveMCPServer,
  stageMCPFixtures,
  type MCPTestWorkspace,
} from './_mcp-test-harness';

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

interface ToolsCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

const ISO_IMPL = `def invoke(*, label, my_token):
    return {
        'label': label,
        'token_first_8': my_token[:8],
        'token_length': len(my_token),
    }
`;

describe('SPE-2078 multi-tool credential isolation', () => {
  let ws: MCPTestWorkspace;
  let toolConfigPath: string;
  let auditPath: string;

  beforeEach(async () => {
    ws = await createMCPTestWorkspace('spe-2078-isolation');
    ({ toolConfigPath, auditPath } = await stageMCPFixtures(ws.workDir, 'iso_pkg', [
      {
        toolSegment: 'tool_a',
        apiName: 'iso_tool_a',
        description: 'Tool A — should only see TOKEN_A',
        args: { label: { type: 'string', description: 'Echoed back' } },
        secrets: [{ canonical: 'my_token', aliases: ['ISO_TOKEN_A'] }],
        implPy: ISO_IMPL,
      },
      {
        toolSegment: 'tool_b',
        apiName: 'iso_tool_b',
        description: 'Tool B — should only see TOKEN_B',
        args: { label: { type: 'string', description: 'Echoed back' } },
        secrets: [{ canonical: 'my_token', aliases: ['ISO_TOKEN_B'] }],
        implPy: ISO_IMPL,
      },
    ]));
  });

  afterEach(async () => {
    await ws.cleanup();
  });

  async function driveBothTools(): Promise<{
    aResult: ToolsCallResult | undefined;
    bResult: ToolsCallResult | undefined;
    auditContents: string;
  }> {
    const { responses } = await driveMCPServer({
      toolConfigPath,
      auditPath,
      workDir: ws.workDir,
      agentId: 'iso-agent',
      routeId: 'iso-route',
      requestId: 'req-iso-probe',
      agentVersion: 'sha256:isotest',
      toolCredentials: {
        iso_tool_a: { my_token: TOKEN_A },
        iso_tool_b: { my_token: TOKEN_B },
      },
      frames: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'iso_tool_a', arguments: { label: 'A-invocation' } },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'iso_tool_b', arguments: { label: 'B-invocation' } },
        },
      ],
    });
    const aResponse = responses.find((r) => r.id === 2)?.result as ToolsCallResult | undefined;
    const bResponse = responses.find((r) => r.id === 3)?.result as ToolsCallResult | undefined;
    let auditContents = '';
    try {
      auditContents = await readFile(auditPath, 'utf-8');
    } catch {
      auditContents = '';
    }
    return { aResult: aResponse, bResult: bResponse, auditContents };
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
