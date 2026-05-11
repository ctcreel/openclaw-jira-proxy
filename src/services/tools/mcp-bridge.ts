import { writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolDescriptor } from './descriptor';
import { buildInputSchema } from './descriptor';
import { getAgentVersion } from '../version.service';

/**
 * Bridge between Clawndom's TypeScript runtime and the ``claude`` CLI's
 * MCP-server registration. Per-run, this builds:
 *
 *   1. A tool-config JSON file the Python MCP server reads at startup
 *      (descriptors only — no credentials on disk).
 *   2. An MCP-config JSON file the ``claude`` CLI takes via ``--mcp-config``.
 *
 * Credentials flow via the ``CLAWNDOM_TOOL_CREDS`` env var (JSON-encoded
 * map ``{tool_name: {requires_name: resolved_value}}``) which the MCP
 * server reads at startup. Env vars are inherited by ``claude`` and passed
 * to the spawned MCP server; they do not exist in the agent's prompt
 * context.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Structured Tool-Use Dispatch.
 */

const SERVER_NAME = 'clawndom-tools';

const MODULE_FILE = fileURLToPath(import.meta.url);
const MCP_SERVER_SCRIPT = resolve(
  dirname(MODULE_FILE),
  '..',
  '..',
  '..',
  'scripts',
  'clawndom_mcp_server.py',
);

export interface ResolvedCredentials {
  /** Map of tool name → {credential name → resolved value}. */
  readonly perTool: Record<string, Record<string, string>>;
}

export interface BridgeContext {
  readonly agentId: string;
  readonly routeId: string;
  readonly requestId: string;
  readonly correlationId?: string;
}

export interface MCPRunFiles {
  readonly mcpConfigPath: string;
  readonly toolConfigPath: string;
  readonly env: Record<string, string>;
}

/**
 * Materialize the MCP config + tool-config files for a per-run invocation
 * of ``claude``. Caller passes the returned ``env`` into the spawn of
 * ``claude`` and adds ``--mcp-config <mcpConfigPath>`` to the CLI args.
 *
 * The temporary files live in a mode-700 directory; clean up after the
 * run by removing the parent dir.
 */
export async function buildMCPRunFiles(
  descriptors: readonly ToolDescriptor[],
  credentials: ResolvedCredentials,
  context: BridgeContext,
): Promise<MCPRunFiles> {
  const workDir = await mkdtemp(join(tmpdir(), 'clawndom-mcp-'));
  await chmod(workDir, 0o700);

  const toolConfig = {
    tools: descriptors.map((d) => ({
      name: d.name,
      description: d.description,
      args: d.args,
      requires: d.requires,
      kind: d.kind,
      reference: d.reference,
      directory: d.directory,
      inputSchema: buildInputSchema(d.args),
    })),
  };
  const toolConfigPath = join(workDir, 'tool-config.json');
  await writeFile(toolConfigPath, JSON.stringify(toolConfig), { mode: 0o600 });

  const mcpConfig = {
    mcpServers: {
      [SERVER_NAME]: {
        command: 'python3',
        args: [MCP_SERVER_SCRIPT, toolConfigPath],
      },
    },
  };
  const mcpConfigPath = join(workDir, 'mcp-config.json');
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });

  const env: Record<string, string> = {
    CLAWNDOM_TOOL_CREDS: JSON.stringify(credentials.perTool),
    CLAWNDOM_AGENT_ID: context.agentId,
    CLAWNDOM_ROUTE_ID: context.routeId,
    CLAWNDOM_REQUEST_ID: context.requestId,
    CLAWNDOM_CORRELATION_ID: context.correlationId ?? context.requestId,
    CLAWNDOM_AGENT_VERSION: getAgentVersion().hash,
  };
  const existingAuditPath = process.env['CLAWNDOM_AUDIT_LOG'];
  if (existingAuditPath !== undefined) {
    env['CLAWNDOM_AUDIT_LOG'] = existingAuditPath;
  }

  return { mcpConfigPath, toolConfigPath, env };
}
