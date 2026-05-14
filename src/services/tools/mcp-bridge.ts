import { existsSync } from 'node:fs';
import { writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolDescriptor } from './descriptor';
import { buildInputSchema } from './descriptor';
import { resolvePythonBinary } from './executor';
import { getAgentVersion } from '../version.service';

/**
 * Bridge between Clawndom's TypeScript runtime and the ``claude`` CLI's
 * MCP-server registration. Per-run, this builds:
 *
 *   1. A tool-config JSON file the Python MCP server reads at startup
 *      (descriptors only — no credentials on disk).
 *   2. An MCP-config JSON file the ``claude`` CLI takes via ``--mcp-config``.
 *
 * Credentials flow via a mode-600 file at the path in
 * ``CLAWNDOM_TOOL_CREDS_FILE`` (JSON-encoded map
 * ``{tool_name: {canonical_name: resolved_value}}``); the MCP server
 * reads it at startup then immediately unlinks it. The literal credential
 * value is never placed in an env var because Linux's ``/proc/<pid>/environ``
 * exposes the kernel-captured envp for the process lifetime, and
 * ``os.environ.pop`` cannot scrub that snapshot. Env vars are inherited
 * by ``claude`` and passed to the spawned MCP server; they do not exist
 * in the agent's prompt context.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Structured Tool-Use Dispatch.
 */

const SERVER_NAME = 'clawndom-tools';

/**
 * Resolve the path to scripts/clawndom_mcp_server.py at runtime.
 *
 * In dev (tsx), `import.meta.url` points at src/services/tools/mcp-bridge.ts
 * so walking up three directories lands at the project root + `scripts/`.
 * In prod (tsup bundle), `import.meta.url` points at dist/server.js — three
 * `..`s overshoot the project root entirely, which was a real production
 * bug discovered during the SPE-2078 EC2 deploy.
 *
 * Resolution order:
 *   1. `CLAWNDOM_MCP_SERVER_SCRIPT` env override — operators set this in
 *      `clawndom.env` to point at the on-disk script path. Always wins.
 *   2. `<project-root>/scripts/clawndom_mcp_server.py` from dev-mode source
 *      layout (works under tsx).
 *   3. `<cwd>/scripts/clawndom_mcp_server.py` — works in prod when systemd
 *      sets `WorkingDirectory=/home/ubuntu/clawndom-winston`.
 *
 * Throws if none of the candidates exists; caller surfaces a clear error
 * at first MCP invocation.
 */
function resolveMCPServerScript(): string {
  const override = process.env['CLAWNDOM_MCP_SERVER_SCRIPT'];
  if (override !== undefined && override.length > 0) return override;

  const sourceLayoutGuess = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'scripts',
    'clawndom_mcp_server.py',
  );
  if (existsSync(sourceLayoutGuess)) return sourceLayoutGuess;

  const cwdGuess = resolve(process.cwd(), 'scripts', 'clawndom_mcp_server.py');
  if (existsSync(cwdGuess)) return cwdGuess;

  throw new Error(
    `Cannot locate clawndom_mcp_server.py. Set CLAWNDOM_MCP_SERVER_SCRIPT to the absolute path. ` +
      `Tried: ${sourceLayoutGuess}, ${cwdGuess}.`,
  );
}

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
      secrets: d.secrets.map((s) => ({ canonical: s.canonical, aliases: [...s.aliases] })),
      reference: d.reference,
      directory: d.directory,
      inputSchema: buildInputSchema(d.args),
    })),
  };
  const toolConfigPath = join(workDir, 'tool-config.json');
  await writeFile(toolConfigPath, JSON.stringify(toolConfig), { mode: 0o600 });

  // Credentials travel as a mode-600 file path, not an env value. The
  // kernel snapshots envp at execve() time and exposes it via
  // /proc/<pid>/environ for the lifetime of the process — even after
  // os.environ.pop. Sending only the path through env means the literal
  // credential value never lands in that snapshot.
  const credsPath = join(workDir, 'tool-creds.json');
  await writeFile(credsPath, JSON.stringify(credentials.perTool), { mode: 0o600 });

  const mcpConfig = {
    mcpServers: {
      [SERVER_NAME]: {
        command: resolvePythonBinary(),
        args: [resolveMCPServerScript(), toolConfigPath],
      },
    },
  };
  const mcpConfigPath = join(workDir, 'mcp-config.json');
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });

  const env: Record<string, string> = {
    CLAWNDOM_TOOL_CREDS_FILE: credsPath,
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
