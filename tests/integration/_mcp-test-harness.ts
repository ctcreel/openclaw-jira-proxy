import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Shared harness for the three SPE-2078 MCP integration tests
 * (mcp-bridge-e2e, credential-leakage-probe, multi-tool-isolation).
 *
 * Encapsulates:
 *   - The on-disk path to the real Python MCP server script.
 *   - Per-test workDir lifecycle (mkdtemp + PYTHONPATH + cleanup).
 *   - Spawn + JSON-RPC drive of the server, including credential transport
 *     via the same mode-600 file Clawndom uses in production
 *     (CLAWNDOM_TOOL_CREDS_FILE — never CLAWNDOM_TOOL_CREDS as an env value,
 *     which would leak through /proc/<pid>/environ on Linux).
 *
 * Tests stay readable in isolation by importing one helper each rather than
 * 50+ lines of fixture scaffolding.
 */

export const SERVER_SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'clawndom_mcp_server.py');

export interface MCPResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

export interface MCPTestWorkspace {
  readonly workDir: string;
  /** Restore PYTHONPATH and rm -rf the workDir. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Create a temp dir prefixed with `prefix-` and prepend it to PYTHONPATH so
 * test-staged Python packages resolve. Caller invokes `cleanup()` in
 * afterEach.
 */
export async function createMCPTestWorkspace(prefix: string): Promise<MCPTestWorkspace> {
  const workDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const originalPythonPath = process.env['PYTHONPATH'];
  process.env['PYTHONPATH'] = `${workDir}:${originalPythonPath ?? ''}`;
  let cleanedUp = false;
  return {
    workDir,
    async cleanup(): Promise<void> {
      if (cleanedUp) return;
      cleanedUp = true;
      if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
      else process.env['PYTHONPATH'] = originalPythonPath;
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

export interface DriveMCPOptions {
  /** Path to the JSON tool-config the server reads on startup. */
  readonly toolConfigPath: string;
  /** Path where the server should write its audit NDJSON. */
  readonly auditPath: string;
  /** Per-run workDir (used to stage the per-tool credentials file). */
  readonly workDir: string;
  readonly agentId: string;
  readonly routeId: string;
  readonly requestId: string;
  readonly agentVersion?: string;
  /**
   * Per-tool credentials map keyed by tool name. Written to a mode-600 file
   * inside workDir; the file path is passed through CLAWNDOM_TOOL_CREDS_FILE.
   * The literal credential value never lands in the spawned process's envp.
   */
  readonly toolCredentials: Record<string, Record<string, string>>;
  /** JSON-RPC frames to write to the server's stdin in order. */
  readonly frames: readonly object[];
}

export interface DriveMCPResult {
  readonly responses: MCPResponse[];
  readonly stderr: string;
}

/**
 * Spawn the real Python MCP server, drive it with the supplied frames,
 * collect parsed responses + stderr. Credentials flow via a mode-600 file
 * so the assertion that env never carries the literal value holds in tests
 * too.
 *
 * NOTE: uses `python3` from PATH. Test environments (vitest + GitHub
 * Actions ubuntu-latest + Mac dev) all provide a trusted PATH; production
 * boot resolves the interpreter via `resolvePythonBinary()` reading
 * `CLAWNDOM_PYTHON_BINARY`, which is the actual prod attack surface.
 */
export async function driveMCPServer(opts: DriveMCPOptions): Promise<DriveMCPResult> {
  const credsFile = join(opts.workDir, 'tool-creds.json');
  await writeFile(credsFile, JSON.stringify(opts.toolCredentials), { mode: 0o600 });

  return new Promise((resolveResult, reject) => {
    // NOSONAR(typescript:S4036): tests run under a trusted PATH (vitest
    // + GHA + dev shells). Production resolves the python binary via
    // resolvePythonBinary() reading CLAWNDOM_PYTHON_BINARY.
    const child = spawn('python3', [SERVER_SCRIPT, opts.toolConfigPath], {
      env: {
        ...process.env,
        CLAWNDOM_AGENT_ID: opts.agentId,
        CLAWNDOM_ROUTE_ID: opts.routeId,
        CLAWNDOM_REQUEST_ID: opts.requestId,
        CLAWNDOM_AGENT_VERSION: opts.agentVersion ?? 'sha256:test',
        CLAWNDOM_AUDIT_LOG: opts.auditPath,
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
      resolveResult({ responses, stderr });
    });
    for (const frame of opts.frames) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    }
    child.stdin.end();
  });
}
