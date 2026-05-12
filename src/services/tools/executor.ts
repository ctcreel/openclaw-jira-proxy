import { spawn } from 'node:child_process';

import { getLogger } from '../../lib/logging';
import { writeAuditRecord } from '../../lib/audit/emit';
import { redactCredentials } from '../../lib/audit/redact';
import type { AuditRecord } from '../../lib/audit/types';
import { getAgentVersion } from '../version.service';
import type { ToolDescriptor } from './descriptor';

const logger = getLogger('tool-executor');

/**
 * Tool execution context passed by the runner. Routes per-invocation
 * identifiers into the audit record without coupling the executor to the
 * runner's event-bus / SSE plumbing.
 */
export interface ToolCallContext {
  readonly agentId: string;
  readonly routeId: string;
  readonly requestId: string;
  readonly correlationId?: string;
}

export interface ToolUseInput {
  /** The tool name surfaced to the model (matches ToolDescriptor.name). */
  readonly name: string;
  /** Args from the model's `tool_use.input`. */
  readonly input: Record<string, unknown>;
}

export interface ToolResult {
  readonly content: unknown;
  readonly isError: boolean;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_RESULT_SUMMARY_BYTES = 4096;

/**
 * Dispatch a single `tool_use` block to the tool's `impl.py` in a Python
 * subprocess. Credentials are injected as kwargs via stdin JSON (never as
 * env vars, never echoed back). Emits exactly one audit record per call,
 * regardless of success or failure.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Structured Tool-Use Dispatch.
 */
export async function executeToolCall(
  toolUse: ToolUseInput,
  descriptor: ToolDescriptor,
  credentials: Readonly<Record<string, string>>,
  context: ToolCallContext,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<ToolResult> {
  const startedAt = Date.now();
  let result: ToolResult;
  let errorSummary: string | null = null;

  try {
    result = await dispatchPython(toolUse, descriptor, credentials, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorSummary = message.split('\n')[0] ?? message;
    result = {
      content: { error: errorSummary },
      isError: true,
    };
  }

  const latencyMs = Date.now() - startedAt;
  const secretValues = Object.values(credentials);
  const redactedArgs = redactCredentials(toolUse.input, secretValues);
  // Result also passes through redaction — a tool that echoes its
  // credential value back (whether by mistake or by adversary input)
  // would otherwise leak it into the audit log via result_summary.
  const resultSummary =
    errorSummary === null
      ? truncateForAudit(redactCredentials(result.content, secretValues))
      : null;

  const record: AuditRecord = {
    timestamp: new Date().toISOString(),
    agent_id: context.agentId,
    route_id: context.routeId,
    tool_name: descriptor.name,
    args: redactedArgs,
    result_summary: resultSummary,
    error_summary: errorSummary,
    latency_ms: latencyMs,
    request_id: context.requestId,
    correlation_id: context.correlationId ?? context.requestId,
    agent_version: getAgentVersion().hash,
  };

  try {
    await writeAuditRecord(record);
  } catch (auditError) {
    // Audit emission failure should not lose the tool result. Log
    // operationally; SPE-2079's logging framework will define the
    // policy for audit-write failures.
    const message = auditError instanceof Error ? auditError.message : String(auditError);
    logger.error({ error: message, tool: descriptor.name }, 'Failed to write audit record');
  }

  return result;
}

async function dispatchPython(
  toolUse: ToolUseInput,
  descriptor: ToolDescriptor,
  credentials: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<ToolResult> {
  const wrapper = `
import json, sys, importlib
module = importlib.import_module(${JSON.stringify(`${descriptor.reference}.impl`)})
payload = json.loads(sys.stdin.read())
result = module.invoke(**payload)
print(json.dumps(result))
`.trim();

  const payload = { ...toolUse.input, ...credentials };
  return runSubprocess(
    resolvePythonBinary(),
    ['-c', wrapper],
    JSON.stringify(payload),
    timeoutMs,
    descriptor,
  );
}

/**
 * Resolve the Python interpreter the executor and signature validator
 * should spawn. Operators on EC2s or Docker images with the venv at a
 * non-standard location set `CLAWNDOM_PYTHON_BINARY` to point at it.
 * Defaults to `python3` (PATH lookup) for local development.
 */
export function resolvePythonBinary(): string {
  const override = process.env['CLAWNDOM_PYTHON_BINARY'];
  return override !== undefined && override !== '' ? override : 'python3';
}

async function runSubprocess(
  command: string,
  args: readonly string[],
  stdinInput: string,
  timeoutMs: number,
  descriptor: ToolDescriptor,
): Promise<ToolResult> {
  return new Promise((resolveResult, reject) => {
    // Credentials are passed via stdin JSON, not env, so the subprocess
    // env stays free of secret material.
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const finish = (resultOrError: ToolResult | Error): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (resultOrError instanceof Error) {
        reject(resultOrError);
      } else {
        resolveResult(resultOrError);
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
      finish(new Error(`Tool '${descriptor.name}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const reason = stderr.trim().split('\n').slice(-3).join(' / ') || `exit ${code}`;
        finish(new Error(`Tool '${descriptor.name}' failed: ${reason}`));
        return;
      }
      try {
        const trimmed = stdout.trim();
        if (trimmed.length === 0) {
          finish({ content: null, isError: false });
          return;
        }
        const parsed: unknown = JSON.parse(trimmed);
        finish({ content: parsed, isError: false });
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        finish(new Error(`Tool '${descriptor.name}' produced non-JSON stdout: ${message}`));
      }
    });

    if (stdinInput !== '') {
      child.stdin.write(stdinInput);
    }
    child.stdin.end();
  });
}

function truncateForAudit(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_RESULT_SUMMARY_BYTES) {
    return `${value.slice(0, MAX_RESULT_SUMMARY_BYTES)}…[truncated]`;
  }
  // For structured results we leave the structure alone; if downstream
  // log forwarders need bytes-level caps, they truncate at their boundary.
  return value;
}
