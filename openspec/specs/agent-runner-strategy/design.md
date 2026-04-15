## Design: Agent Runner Strategy

### Architecture Overview

A new `src/runners/` directory sits at the infrastructure adapter layer, parallel to `src/strategies/`. It owns the interface between a rendered prompt and whatever backend executes it. The worker service depends on the `AgentRunner` interface — never on a concrete runner implementation.

```
src/runners/
  types.ts              — AgentRunner interface, RunOptions, RunResult, RunnerConfig schemas
  registry.ts           — Runner registry (register, resolve by name, list registered)
  openclaw.runner.ts    — Wraps GatewayClient.runAndWait (preserves current behavior exactly)
  claude-cli.runner.ts  — Spawns claude subprocess, parses stream-json output
  openai.runner.ts      — Calls OpenAI /v1/chat/completions
  bedrock.runner.ts     — Calls AWS Bedrock InvokeModel
  null.runner.ts        — No-op, returns ok immediately (tests only)
  index.ts              — Barrel export
```

### Interface Contracts

```typescript
// src/runners/types.ts

export interface RunOptions {
  prompt: string;
  sessionKey: string;
  agentId: string;
  model?: string;
  timeoutMs: number;
}

export interface RunResult {
  status: 'ok' | 'error' | 'timeout';
  runId?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  renderedPrompt: string;  // captured by runner for observability
}

export interface AgentRunner {
  readonly name: string;
  run(options: RunOptions): Promise<RunResult>;
  connect?(): Promise<void>;   // optional — runners with persistent connections
  close?(): Promise<void>;     // optional — runners with persistent connections
  isHealthy?(): boolean;       // optional — runners report own readiness
}
```

### Runner Implementations

#### OpenClawRunner

Wraps `GatewayClient.runAndWait`. No behavior change from current worker logic. Captures `renderedPrompt` from `options.prompt`.

```typescript
export class OpenClawRunner implements AgentRunner {
  readonly name = 'openclaw';
  constructor(private readonly gatewayClient: GatewayClient) {}

  async connect(): Promise<void> { await this.gatewayClient.connect(); }
  async close(): Promise<void> { await this.gatewayClient.close(); }
  isHealthy(): boolean { return this.gatewayClient.connected; }

  async run(options: RunOptions): Promise<RunResult> {
    const result = await this.gatewayClient.runAndWait(
      {
        message: options.prompt,
        sessionKey: options.sessionKey,
        agentId: options.agentId,
        model: options.model,
        bootstrapContextMode: 'lightweight',
      },
      options.timeoutMs,
    );
    return { ...result, renderedPrompt: options.prompt };
  }
}
```

#### ClaudeCliRunner

Spawns `claude -p` as a child process. Uses `stream-json` output format to parse structured results from stdout. Session is stateless — no `--resume`. Working directory is set per runner config.

Key implementation details:
- Strips `ANTHROPIC_API_KEY` is NOT done by the runner — this is intentionally the operator's responsibility (see proposal). The runner passes `process.env` unchanged.
- Timeout is enforced by `setTimeout` + `proc.kill()`.
- Parses JSONL stdout for `type: "result"` blocks to extract the assistant's response.
- Exit code non-zero with no output → throws (job fails, BullMQ retries).
- Exit code non-zero with output → returns output with `status: 'error'`.

```typescript
export class ClaudeCliRunner implements AgentRunner {
  readonly name = 'claude-cli';
  constructor(private readonly config: ClaudeCliRunnerConfig) {}

  isHealthy(): boolean {
    // Check binary exists on PATH — synchronous existsSync check
    return existsSync(this.config.binary ?? 'claude') ||
           Boolean(which.sync(this.config.binary ?? 'claude', { nothrow: true }));
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const args = buildClaudeArgs(options, this.config);
    const output = await spawnClaude(args, this.config.workDir, options.timeoutMs);
    return {
      status: 'ok',
      renderedPrompt: options.prompt,
      startedAt,
      endedAt: new Date().toISOString(),
      runId: `cli-${Date.now()}`,
      ...output,
    };
  }
}

function buildClaudeArgs(options: RunOptions, config: ClaudeCliRunnerConfig): string[] {
  const args = [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];
  if (options.model) args.push('--model', options.model);
  if (config.systemPrompt) args.push('--append-system-prompt', config.systemPrompt);
  return args;
}
```

#### OpenAiRunner

Calls `/v1/chat/completions` via `fetch`. Accepts `baseUrl` for compatible endpoints (e.g., Azure OpenAI, local Ollama). No persistent connection — stateless HTTP.

```typescript
export class OpenAiRunner implements AgentRunner {
  readonly name = 'openai';
  constructor(private readonly config: OpenAiRunnerConfig) {}

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com';
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model ?? this.config.model,
        messages: [{ role: 'user', content: options.prompt }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status}`, renderedPrompt: options.prompt };
    }
    return {
      status: 'ok',
      renderedPrompt: options.prompt,
      startedAt,
      endedAt: new Date().toISOString(),
      runId: `openai-${Date.now()}`,
    };
  }
}
```

#### BedrockRunner

Calls `InvokeModel` via `@aws-sdk/client-bedrock-runtime`. Uses ambient AWS credentials — no key in config. Model ID is required (e.g., `anthropic.claude-sonnet-4-6-v1`).

```typescript
export class BedrockRunner implements AgentRunner {
  readonly name = 'bedrock';
  private client: BedrockRuntimeClient;

  constructor(private readonly config: BedrockRunnerConfig) {
    this.client = new BedrockRuntimeClient({ region: config.region });
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const command = new InvokeModelCommand({
      modelId: options.model ?? this.config.modelId,
      contentType: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8096,
        messages: [{ role: 'user', content: options.prompt }],
      }),
    });
    const response = await this.client.send(command);
    return {
      status: 'ok',
      renderedPrompt: options.prompt,
      startedAt,
      endedAt: new Date().toISOString(),
      runId: `bedrock-${Date.now()}`,
    };
  }
}
```

#### NullRunner

```typescript
export class NullRunner implements AgentRunner {
  readonly name = 'null';
  async run(options: RunOptions): Promise<RunResult> {
    return { status: 'ok', renderedPrompt: options.prompt, runId: 'null-run' };
  }
}
```

### Runner Registry

```typescript
// src/runners/registry.ts

const runners: Record<string, AgentRunner> = {};

export function registerRunner(runner: AgentRunner): void {
  runners[runner.name] = runner;
}

export function getRunner(name: string): AgentRunner {
  const runner = runners[name];
  if (!runner) {
    throw new Error(`Unknown runner: ${name}. Registered: ${Object.keys(runners).join(', ')}`);
  }
  return runner;
}

export function getRegisteredRunners(): AgentRunner[] {
  return Object.values(runners);
}

export function resetRunners(): void {
  for (const key of Object.keys(runners)) delete runners[key];
}
```

### Config Schema Extension

```typescript
// runner config schemas added to src/runners/types.ts

const openclawRunnerConfigSchema = z.object({ type: z.literal('openclaw') });

const claudeCliRunnerConfigSchema = z.object({
  type: z.literal('claude-cli'),
  binary: z.string().default('claude'),
  workDir: z.string().min(1),
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

`src/config.ts` provider schema gains an optional `runner` field:

```typescript
const providerSchema = z.object({
  // ...existing fields...
  runner: runnerConfigSchema.optional(),  // defaults to openclaw if absent
});
```

### Worker Integration

`processJob` in `worker.service.ts` replaces the direct `gatewayClient.runAndWait` call:

```typescript
// Before
const result = await gatewayClient.runAndWait({ message, sessionKey, agentId }, timeoutMs);

// After
const runnerName = provider.runner?.type ?? 'openclaw';
const runner = getRunner(runnerName);
const result = await runner.run({ prompt: message, sessionKey, agentId, model: selectedModel, timeoutMs });
```

Prompt observability logging added immediately after `runner.run` resolves:

```typescript
logger.debug(
  {
    jobId: job.id,
    provider: provider.name,
    sessionKey,
    runner: runnerName,
    promptHash: createHash('sha256').update(result.renderedPrompt).digest('hex').slice(0, 12),
    promptLength: result.renderedPrompt.length,
    prompt: result.renderedPrompt,
  },
  'Agent run prompt',
);

logger.info(
  {
    jobId: job.id,
    provider: provider.name,
    sessionKey,
    runner: runnerName,
    promptHash: createHash('sha256').update(result.renderedPrompt).digest('hex').slice(0, 12),
    promptLength: result.renderedPrompt.length,
  },
  'Agent run delivered',
);
```

`createWorker` signature changes:

```typescript
// Before
export function createWorker(options: {
  provider: ProviderConfig;
  gatewayClient: GatewayClient;
  alertRegistry?: AlertRegistry;
}): Worker<string>

// After
export function createWorker(options: {
  provider: ProviderConfig;
  alertRegistry?: AlertRegistry;
  // runner resolved from registry inside processJob — no direct dependency
}): Worker<string>
```

### Health Service Integration

`health.service.ts` queries runner health instead of checking gateway connection directly:

```typescript
// Before: one hardcoded gateway check
const wsCheck = { name: 'gateway-websocket', status: gatewayClient.connected ? 'healthy' : 'degraded' };

// After: one check per registered runner that implements isHealthy()
const runnerChecks = getRegisteredRunners()
  .filter((runner) => runner.isHealthy !== undefined)
  .map((runner) => ({
    name: `runner:${runner.name}`,
    status: runner.isHealthy!() ? 'healthy' : 'degraded',
  }));
```

If no provider uses the `openclaw` runner, `GatewayClient` is not instantiated and no gateway check appears in health output.

### Startup Wiring

```typescript
// src/server.ts (startup sequence)

// 1. Register null runner always (available for testing via PROVIDERS_CONFIG)
registerRunner(new NullRunner());

// 2. Determine which runner types are actually needed
const neededRunnerTypes = new Set(
  settings.providers.map((provider) => provider.runner?.type ?? 'openclaw')
);

// 3. Instantiate and register only what's needed
if (neededRunnerTypes.has('openclaw')) {
  const gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, settings.openclawToken);
  const openclawRunner = new OpenClawRunner(gatewayClient);
  registerRunner(openclawRunner);
  await openclawRunner.connect();
}

if (neededRunnerTypes.has('claude-cli')) {
  for (const provider of settings.providers) {
    if (provider.runner?.type === 'claude-cli') {
      // Register once per unique workDir config
      const runner = new ClaudeCliRunner(provider.runner);
      registerRunner(runner); // registry key is 'claude-cli' — last one wins if multiple configs
      break;
    }
  }
}

// OpenAI and Bedrock are stateless — instantiate per provider if needed
// (runner registry by type name means one instance handles all providers of that type)
```

### Preview Script

```typescript
// scripts/preview-template.ts
// Usage: pnpm tsx scripts/preview-template.ts --template <path> --payload <path>

import { readFile } from 'fs/promises';
import { renderTemplate } from '../src/lib/template/template-engine';

const args = parseArgs(process.argv.slice(2));
const template = await readFile(args.template, 'utf-8');
const payload = JSON.parse(await readFile(args.payload, 'utf-8'));
const rendered = await renderTemplate(template, payload);

process.stdout.write(rendered);
```

Makefile target:

```makefile
preview-template:
	pnpm tsx scripts/preview-template.ts --template $(TEMPLATE) --payload $(PAYLOAD)
```

### Dependency Addition

- `@aws-sdk/client-bedrock-runtime` — optional peer dep, added to `package.json` devDependencies with a try/require guard in `bedrock.runner.ts` so the package is optional at runtime
- No new dependencies for `claude-cli` runner (uses Node.js `child_process`) or `openai` runner (uses native `fetch`)
- `which` package for binary path resolution in `ClaudeCliRunner.isHealthy()`
