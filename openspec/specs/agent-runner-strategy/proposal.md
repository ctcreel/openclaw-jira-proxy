## Change: Agent Runner Strategy

### Summary

Introduce a pluggable `AgentRunner` abstraction that decouples prompt delivery from the OpenClaw gateway, enabling per-provider runner selection (OpenClaw, Claude CLI, OpenAI API, Amazon Bedrock, and others) while absorbing prompt visibility as a first-class concern of every runner implementation.

### Motivation

Currently, `processJob` in `worker.service.ts` is hardwired to `GatewayClient.runAndWait`. The OpenClaw WebSocket protocol is the only execution path — there is no seam between "a rendered prompt is ready" and "send it somewhere." This creates three compounding problems:

**Runner lock-in.** Routing Patch through the Claude CLI (for Max subscription billing), routing a lightweight summarization task through an OpenAI model, or routing a cost-sensitive classification job through Bedrock all require forking `worker.service.ts`. There is no sanctioned extension point.

**Health check coupling.** The OpenClaw WebSocket connection is a startup dependency checked on every health call. A provider configured to use the Claude CLI has no gateway dependency, but the health check will report degraded status if the gateway is unreachable — a false signal.

**Prompt invisibility.** The rendered message delivered to the runner is never logged or stored. When Patch behaves unexpectedly, the only debug path is reconstructing the prompt from the raw payload and the template — which requires knowing which template fired. The runner boundary is the correct place to capture what was actually sent, because the runner is the last code that sees the fully-rendered prompt before it leaves the process.

Addressing runner lock-in without also addressing prompt visibility would mean retrofitting visibility into every future runner independently. These belong together.

### Design

#### Runner Interface

```typescript
// src/runners/types.ts

export interface RunOptions {
  /** Fully rendered prompt — template already applied. */
  prompt: string;
  /** Session key for correlation and dedup. */
  sessionKey: string;
  /** Agent identifier (used by runners that support multi-agent dispatch). */
  agentId: string;
  /** Optional model override — runner may ignore if not applicable. */
  model?: string;
  /** Maximum time to wait for the run to complete, in milliseconds. */
  timeoutMs: number;
}

export interface RunResult {
  status: 'ok' | 'error' | 'timeout';
  runId?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  /** Rendered prompt as delivered — captured by the runner for observability. */
  renderedPrompt: string;
}

export interface AgentRunner {
  readonly name: string;
  run(options: RunOptions): Promise<RunResult>;
  /** Called at startup — runner performs any connection/readiness checks. */
  connect?(): Promise<void>;
  /** Called at shutdown — runner releases resources. */
  close?(): Promise<void>;
  /** Health check — runner reports its own readiness. */
  isHealthy?(): boolean;
}
```

#### Runner Implementations

```
src/runners/
  types.ts              — AgentRunner interface, RunOptions, RunResult
  registry.ts           — Runner registry (register + resolve by name)
  openclaw.runner.ts    — Wraps existing GatewayClient.runAndWait (current behavior)
  claude-cli.runner.ts  — Spawns claude -p subprocess, captures stream-json output
  openai.runner.ts      — Calls OpenAI chat completions API directly
  bedrock.runner.ts     — Calls AWS Bedrock invoke endpoint
  null.runner.ts        — No-op, for testing
  index.ts              — Barrel export
```

**OpenClaw runner** — wraps `GatewayClient` with no behavior change. Existing `openclawHookUrl`, `openclawGatewayWsUrl`, and `openclawToken` config keys remain valid.

**Claude CLI runner** — spawns `claude -p` with `--output-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions`. Parses JSONL stdout for `type: "result"`. Session is stateless (no `--resume`) — context is the working directory and the rendered prompt. Working directory is configurable per-runner config.

**OpenAI runner** — calls `/v1/chat/completions`. Accepts `model`, `baseUrl` (for compatible endpoints), and `apiKey` in runner config. No session concept — each run is independent.

**Bedrock runner** — calls `InvokeModel` via `@aws-sdk/client-bedrock-runtime`. Accepts `modelId`, `region`. Uses ambient AWS credentials (IAM role or env vars — no key storage in config).

**Null runner** — returns `{ status: 'ok', renderedPrompt: options.prompt }` immediately. Used in tests in place of mocking `GatewayClient`.

#### Runner Config Schema

`PROVIDERS_CONFIG` entries gain an optional `runner` key. If absent, defaults to `openclaw` (backward compatible).

```typescript
// src/runners/types.ts (config schemas)

const openclawRunnerConfigSchema = z.object({
  type: z.literal('openclaw'),
  // uses global OPENCLAW_TOKEN, OPENCLAW_GATEWAY_WS_URL, OPENCLAW_HOOK_URL
});

const claudeCliRunnerConfigSchema = z.object({
  type: z.literal('claude-cli'),
  /** Absolute path to the claude binary. Defaults to 'claude' (PATH lookup). */
  binary: z.string().default('claude'),
  /** Working directory for the subprocess. Required. */
  workDir: z.string().min(1),
  /** Additional --append-system-prompt content. Optional. */
  systemPrompt: z.string().optional(),
});

const openaiRunnerConfigSchema = z.object({
  type: z.literal('openai'),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

const bedrockRunnerConfigSchema = z.object({
  type: z.literal('bedrock'),
  modelId: z.string().min(1),
  region: z.string().min(1),
});

export const runnerConfigSchema = z.discriminatedUnion('type', [
  openclawRunnerConfigSchema,
  claudeCliRunnerConfigSchema,
  openaiRunnerConfigSchema,
  bedrockRunnerConfigSchema,
]);

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
```

Example `PROVIDERS_CONFIG` entry:

```json
{
  "name": "github",
  "routePath": "/hooks/github",
  "hmacSecret": "...",
  "signatureStrategy": "github",
  "openclawHookUrl": "http://127.0.0.1:18789/hooks/agent",
  "runner": {
    "type": "claude-cli",
    "workDir": "/Users/christopher/code/signalfield",
    "systemPrompt": "You are Patch, a SignalField engineering agent."
  },
  "routing": { "default": "patch" }
}
```

#### Prompt Visibility

Every runner captures `renderedPrompt` in `RunResult`. The worker logs it at `debug` level with a SHA-256 hash for correlation:

```typescript
// in processJob, after runner.run() resolves
logger.debug(
  {
    jobId: job.id,
    provider: provider.name,
    sessionKey,
    promptHash: createHash('sha256').update(result.renderedPrompt).digest('hex').slice(0, 12),
    promptLength: result.renderedPrompt.length,
    prompt: result.renderedPrompt,   // only emitted at debug level
  },
  'Agent run prompt',
);
```

At `info` level, only `promptHash` and `promptLength` are logged — no PII/payload leakage in production. At `debug` level, the full rendered prompt is included. `LOG_LEVEL=debug` is sufficient to reconstruct exactly what Patch received for any job.

A new `scripts/preview-template.ts` supports authoring-time visibility:

```bash
make preview-template TEMPLATE=path/to/template.md PAYLOAD=samples/jira-issue-updated.json
```

This renders the template against the sample payload and prints to stdout — no network calls, no runner invocation. Sample payloads live in `samples/` (gitignored by default, committed per project preference).

#### Worker Integration

`processJob` is decoupled from `GatewayClient`:

```typescript
// Before (current)
const result = await gatewayClient.runAndWait({ message, sessionKey, agentId }, timeoutMs);

// After
const runner = getRunner(provider.runner?.type ?? 'openclaw');
const result = await runner.run({ prompt: message, sessionKey, agentId, model: selectedModel, timeoutMs });
```

`createWorker` no longer accepts `gatewayClient` directly — it accepts a `RunnerRegistry` instead. The `OpenClawRunner` instance holds the `GatewayClient` reference internally.

#### Health Check

The health service queries each registered runner's `isHealthy()` rather than checking the gateway connection directly:

```typescript
// OpenClawRunner.isHealthy() → returns gatewayClient.connected
// ClaudeCliRunner.isHealthy() → checks binary exists on PATH
// OpenAiRunner.isHealthy() → true (stateless HTTP, no persistent connection)
// BedrockRunner.isHealthy() → true (stateless HTTP)
```

A provider using the Claude CLI runner will not show a degraded gateway check — only runners actually in use contribute to health status.

#### Startup Wiring

```typescript
// src/server.ts (startup)
const runnerRegistry = createRunnerRegistry();

// Always register openclaw runner (used by providers without explicit runner config)
const gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, settings.openclawToken);
registerRunner(runnerRegistry, new OpenClawRunner(gatewayClient));

// Register other runners as needed based on PROVIDERS_CONFIG
registerRunnersForProviders(runnerRegistry, settings.providers);
```

Runners with a `connect()` method are connected at startup. Runners without it (OpenAI, Bedrock) are stateless and need no startup call.

### Backward Compatibility

- Providers with no `runner` key in config → `openclaw` runner (identical to current behavior)
- `GatewayClient` is unchanged — `OpenClawRunner` wraps it with no interface change
- `OPENCLAW_TOKEN`, `OPENCLAW_GATEWAY_WS_URL` remain valid global config
- `openclawHookUrl` per-provider config remains valid (used by `OpenClawRunner`)
- If no provider uses `openclaw` runner, the `GatewayClient` is not instantiated and the gateway health check is omitted entirely

### Files

| File | Action | Lines |
|------|--------|-------|
| `src/runners/types.ts` | New | ~60 |
| `src/runners/registry.ts` | New | ~25 |
| `src/runners/openclaw.runner.ts` | New | ~50 |
| `src/runners/claude-cli.runner.ts` | New | ~90 |
| `src/runners/openai.runner.ts` | New | ~60 |
| `src/runners/bedrock.runner.ts` | New | ~60 |
| `src/runners/null.runner.ts` | New | ~15 |
| `src/runners/index.ts` | New | ~10 |
| `src/config.ts` | Modify | +40 (runner config schema, provider schema extension) |
| `src/services/worker.service.ts` | Modify | +15, -10 (replace gatewayClient.runAndWait, add prompt logging) |
| `src/services/health.service.ts` | Modify | +20 (runner-based health checks) |
| `src/server.ts` | Modify | +25 (runner registry wiring) |
| `scripts/preview-template.ts` | New | ~40 |
| `Makefile` | Modify | +5 (preview-template target) |
| `tests/runners/openclaw.runner.test.ts` | New | ~80 |
| `tests/runners/claude-cli.runner.test.ts` | New | ~100 |
| `tests/runners/openai.runner.test.ts` | New | ~70 |
| `tests/runners/bedrock.runner.test.ts` | New | ~70 |
| `tests/runners/null.runner.test.ts` | New | ~20 |
| `tests/runners/registry.test.ts` | New | ~30 |
| `tests/services/worker.service.test.ts` | Modify | +40 (runner integration, prompt logging) |
| `tests/services/health.service.test.ts` | Modify | +30 (runner health checks) |

### Capabilities Modified

- `webhook-proxy-domain`: Event Forwarding requirement — execution path now goes through runner registry, not directly to gateway client
- `observability`: Structured Logging requirement — prompt hash/length at info, full prompt at debug; new `preview-template` script
- `infrastructure`: OpenClaw Gateway Dependency requirement — gateway is now optional, instantiated only when at least one provider uses the `openclaw` runner
- `code-architecture`: Layered Architecture requirement — `src/runners/` is a new infrastructure adapter layer; runners implement domain-defined `AgentRunner` interface

### Estimation

- **Risk:** Medium — modifies `worker.service.ts` and health service, both on the critical processing path. OpenClaw runner wraps existing behavior exactly, limiting regression surface.
- **Intensity:** Medium — new directory, four runner implementations, config schema extension, startup wiring refactor
- **Story Points:** 8
- **Total new code:** ~530 lines source + ~440 lines tests
