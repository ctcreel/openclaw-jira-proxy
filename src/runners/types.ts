import { z } from 'zod';

import type { ProviderConfig } from '../config';
import type { SessionConfig, SessionKeyStrategy } from '../strategies/session-key';

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
  /**
   * Per-run system prompt content extracted from the rendered template via
   * `{{system-doc:…}}` / `{{system-shared:…}}` tags. When present, runners
   * that support a separate system slot (e.g. `claude-cli` via
   * `--system-prompt`) MUST forward this content there rather than inlining
   * it in the user prompt. Anthropic prompt caching engages on the system
   * block when it's stable across runs, so isolating cache-eligible content
   * here is the only way per-event-spawn runs benefit from caching.
   *
   * If the runner config also defines a static `systemPrompt`, the two MUST
   * be concatenated (config first, then per-run) so both are part of the
   * cached prefix.
   */
  systemPrompt?: string;
  /**
   * When set, the runner resumes the existing claude-cli session with
   * this id (`claude --resume <sessionId>`) instead of spawning a fresh
   * conversation. Used by the quota-aware pause path: when a run's
   * stream parser captured the session_id and the run subsequently hit
   * the upstream quota wall, the requeue envelope carries the id so the
   * resumed pickup continues the same conversation rather than restarting
   * the plan from scratch. Runners that don't support resume (everything
   * except claude-cli today) MUST ignore this field.
   */
  resumeSessionId?: string;
  /**
   * Per-run override for the runner's conversation-turn ceiling. Defaults
   * to 150 (claude-cli's prior hardcoded value) when omitted. Routing
   * rules whose work cascades wider than 150 turns (multi-file test-tuple
   * updates, structural refactors) opt in via the rule's `maxTurns`
   * field; the worker forwards it here. Other runners ignore.
   */
  maxTurns?: number;
  /**
   * SPE-2078: per-run tool registration. When present, the runner is
   * expected to expose these tools to the model via the Anthropic tool-use
   * protocol (claude-cli does this via MCP-server registration in the
   * MCPBundle.mcpConfigPath). Each tool's `requires:` credentials live in
   * `mcpBundle.env.CLAWNDOM_TOOL_CREDS` (JSON-encoded) and are passed to
   * the MCP server, never to the agent's prompt context. Runners that
   * don't support tool-use (e.g. `openai`, `bedrock` today) MUST ignore.
   */
  mcpBundle?: ToolMCPBundle;
}

/**
 * Output of `buildMCPRunFiles` from `src/services/tools/mcp-bridge.ts`.
 * Carries the on-disk paths the claude CLI needs (`--mcp-config`) plus
 * the env vars the MCP server reads at startup. Caller is responsible
 * for cleanup of the parent temp dir after the run completes.
 */
export interface ToolMCPBundle {
  readonly mcpConfigPath: string;
  readonly toolConfigPath: string;
  readonly env: Record<string, string>;
}

/**
 * Options for session-aware runs (warm subprocess + Redis-resume).
 *
 * `firstTurnPrompt` is the rendered template used to seed a fresh session
 * (IDENTITY + SOUL + template + this event's payload). On subsequent turns
 * within the same session, only `userMessage` is sent — the prior context
 * is already in the subprocess's session JSONL.
 */
export interface SessionRunOptions {
  /** Provider name (e.g. "slack-winston") — used for Redis key namespacing and observability. */
  providerName: string;
  /** Provider config — passed to strategies that need it. */
  providerConfig: ProviderConfig;
  /** Strategy-derived session key (e.g. a Slack channel id). */
  sessionKey: string;
  /** Session-key strategy — used by the pool when respawning to verify the key. */
  strategy: SessionKeyStrategy;
  /** Per-route session config (ttl, idleTimeout). */
  sessionConfig: SessionConfig;
  /**
   * Rendered template for a freshly-spawned session — IDENTITY/SOUL/template
   * + this event's payload. Sent as the first user message when the session
   * is brand new. Ignored on warm-reuse and resume paths.
   */
  firstTurnPrompt: string;
  /**
   * The current event's user message — sent on every turn, warm or cold.
   * On a fresh spawn this is implicitly part of `firstTurnPrompt`; on resume
   * and warm paths this is the only thing the subprocess sees.
   */
  userMessage: string;
  /** Target agent identifier. */
  agentId: string;
  /** Optional model override. */
  model?: string;
  /** Maximum time (ms) for this single turn. */
  timeoutMs: number;
  /** Trace + job correlation. */
  traceId?: string;
  jobId?: string;
  /** Extra environment variables exposed when (re)spawning the subprocess. */
  env?: Record<string, string>;
}

export interface RunResult {
  /**
   * Terminal status of the run.
   *
   * `quota_exceeded` is the cross-runner signal for "the upstream provider
   * told us to stop spending money/tokens for now." Each runner detects its
   * own provider's quota signal (claude-cli parses the assistant_text
   * "You've hit your limit" message; openai/bedrock would catch HTTP 429 +
   * Retry-After / ThrottlingException). The worker treats this differently
   * from `error`: instead of consuming a retry attempt, it pauses the queue
   * until `quotaResetAt` and re-enqueues the same envelope so the same
   * ticket resumes when the provider is healthy again — no Jira-board
   * ping-pong, no lost work.
   */
  status: 'ok' | 'error' | 'timeout' | 'quota_exceeded';
  /** Runner-assigned run identifier (when available). */
  runId?: string;
  /** Error message when status is 'error'. */
  error?: string;
  /**
   * Wall-clock millis when the upstream provider says the quota window
   * resets. Set only when `status === 'quota_exceeded'`. Worker schedules
   * the queue resume at or after this time.
   */
  quotaResetAt?: number;
  /**
   * Session id captured from claude-cli's `system.init` event. Set by the
   * claude-cli runner whenever the run produced one (status: 'ok',
   * 'quota_exceeded', and most error/timeout cases will all have it
   * because system.init fires before the first claude turn). Worker
   * persists this onto the requeue envelope when handling
   * `quota_exceeded` so the resumed pickup continues the conversation
   * via `claude --resume <id>` instead of replanning from scratch.
   * Runners other than claude-cli leave this undefined.
   */
  sessionId?: string;
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

  /**
   * Execute one turn against a session-aware (warm) subprocess. Optional —
   * runners that don't support the session model should leave this
   * undefined and the worker will fall back to `run()`.
   */
  runSession?(options: SessionRunOptions): Promise<RunResult>;

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

// Shell runner config — used on a per-rule basis for `routing.schedule`
// rules that execute maintenance commands instead of LLM prompts. Unlike
// the other runner types, shell runners are constructed per-firing and
// never registered in the global runner registry, because their config
// (the command) varies per rule rather than per deployment.
const shellRunnerConfigSchema = z.object({
  type: z.literal('shell'),
  /** Command to execute, parsed by /bin/sh. */
  command: z.string().min(1),
  /** Working directory; defaults to the agent workspace directory. */
  cwd: z.string().optional(),
  /** Extra environment variables, merged on top of process.env (and any per-firing env). */
  env: z.record(z.string(), z.string()).optional(),
  /** Wall-clock timeout in milliseconds. SIGTERM at this point, SIGKILL after a 5s grace period. */
  timeoutMs: z.number().int().positive().default(300_000),
});

export const runnerConfigSchema = z.discriminatedUnion('type', [
  openclawRunnerConfigSchema,
  claudeCliRunnerConfigSchema,
  openaiRunnerConfigSchema,
  bedrockRunnerConfigSchema,
  shellRunnerConfigSchema,
]);

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
export type OpenClawRunnerConfig = z.infer<typeof openclawRunnerConfigSchema>;
export type ClaudeCliRunnerConfig = z.infer<typeof claudeCliRunnerConfigSchema>;
export type OpenAiRunnerConfig = z.infer<typeof openaiRunnerConfigSchema>;
export type BedrockRunnerConfig = z.infer<typeof bedrockRunnerConfigSchema>;
export type ShellRunnerConfig = z.infer<typeof shellRunnerConfigSchema>;
