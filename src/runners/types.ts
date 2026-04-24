import { z } from 'zod';

// ---------------------------------------------------------------------------
// Runner interface
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Rendered prompt to send to the runner. */
  prompt: string;
  /** Session key for traceability. */
  sessionKey: string;
  /** Target agent identifier. */
  agentId: string;
  /** Optional model override (e.g. "anthropic/claude-opus-4-7"). */
  model?: string;
  /** Maximum time (ms) the runner may take before the caller treats it as timed out. */
  timeoutMs: number;
  /** Trace identifier used for SSE event correlation. */
  traceId?: string;
  /** Job identifier used for SSE event correlation. */
  jobId?: string;
  /**
   * Extra environment variables to expose to the runner's subprocess (if any).
   * Merged on top of `process.env` by runners that spawn child processes.
   * Runners that don't spawn subprocesses may ignore this field.
   */
  env?: Record<string, string>;
}

export interface RunResult {
  /** Terminal status of the run. */
  status: 'ok' | 'error' | 'timeout';
  /** Runner-assigned run identifier (when available). */
  runId?: string;
  /** Error message when status is 'error'. */
  error?: string;
  /** ISO-8601 timestamp when the run started. */
  startedAt?: string;
  /** ISO-8601 timestamp when the run ended. */
  endedAt?: string;
  /** The prompt that was actually delivered (captured for observability). */
  renderedPrompt: string;
}

/**
 * Pluggable agent runner.
 *
 * Implementations wrap a specific execution backend (OpenClaw gateway,
 * Claude CLI, OpenAI API, AWS Bedrock, etc.).
 */
export interface AgentRunner {
  /** Unique name used in config and health checks (e.g. "openclaw", "claude-cli"). */
  readonly name: string;

  /** Execute a prompt and wait for a terminal result. */
  run(options: RunOptions): Promise<RunResult>;

  /** Optional: establish persistent connections (called once at startup). */
  connect?(): Promise<void>;

  /** Optional: tear down connections (called on shutdown). */
  close?(): Promise<void>;

  /** Optional: return true if the runner is ready to accept work. */
  isHealthy?(): boolean;
}

// ---------------------------------------------------------------------------
// Runner config schemas (discriminated union by `type`)
// ---------------------------------------------------------------------------

const openclawRunnerConfigSchema = z.object({
  type: z.literal('openclaw'),
});

const claudeCliRunnerConfigSchema = z.object({
  type: z.literal('claude-cli'),
  /** Working directory for the Claude CLI process. */
  workDirectory: z.string().min(1),
  /** Path to the claude binary (default: resolved via PATH). */
  binary: z.string().optional(),
  /** System prompt passed via --system-prompt flag. */
  systemPrompt: z.string().optional(),
});

const openaiRunnerConfigSchema = z.object({
  type: z.literal('openai'),
  /** Model identifier (e.g. "gpt-4o"). */
  model: z.string().min(1),
  /** API key for authentication. */
  apiKey: z.string().min(1),
  /** Base URL for OpenAI-compatible endpoints (default: https://api.openai.com/v1). */
  baseUrl: z.string().url().optional(),
});

const bedrockRunnerConfigSchema = z.object({
  type: z.literal('bedrock'),
  /** Bedrock model ID (e.g. "anthropic.claude-3-sonnet-20240229-v1:0"). */
  modelId: z.string().min(1),
  /** AWS region (e.g. "us-east-1"). */
  region: z.string().min(1),
});

export const runnerConfigSchema = z.discriminatedUnion('type', [
  openclawRunnerConfigSchema,
  claudeCliRunnerConfigSchema,
  openaiRunnerConfigSchema,
  bedrockRunnerConfigSchema,
]);

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
export type OpenClawRunnerConfig = z.infer<typeof openclawRunnerConfigSchema>;
export type ClaudeCliRunnerConfig = z.infer<typeof claudeCliRunnerConfigSchema>;
export type OpenAiRunnerConfig = z.infer<typeof openaiRunnerConfigSchema>;
export type BedrockRunnerConfig = z.infer<typeof bedrockRunnerConfigSchema>;
