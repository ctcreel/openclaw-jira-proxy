## MODIFIED Requirements

### Requirement: Agent Runner Abstraction

The worker MUST NOT depend directly on any concrete runner implementation. All prompt delivery MUST go through the `AgentRunner` interface. The runner for a provider MUST be resolved from the runner registry using `provider.runner.type` (defaulting to `"openclaw"` if absent).

Runners MUST be registered at startup before any worker processes jobs. An unknown runner type in `PROVIDERS_CONFIG` MUST cause startup to fail with a clear error.

Built-in runner types:
- **`openclaw`** — Delivers via OpenClaw gateway RPC (`agent.wait`). Default when `runner` is absent.
- **`claude-cli`** — Spawns `claude -p` subprocess. Requires `workDir`.
- **`openai`** — Calls OpenAI `/v1/chat/completions`. Requires `model` and `apiKey`.
- **`bedrock`** — Calls AWS Bedrock `InvokeModel`. Requires `modelId` and `region`. Uses ambient AWS credentials.
- **`shell`** — Spawns the configured `command` as a child process. No prompt rendering, no template, no model invocation. Captures stdout and stderr; emits `runner.tool_call` style events for the spawn and a `runner.complete` (exit 0) or `runner.error` (non-zero exit, timeout, or signal). Time-bounded by an optional `timeoutMs` (default 5 min). For maintenance and infrastructure tasks (e.g., periodic API token refresh) that do not require an LLM. Intentionally unprivileged from the agent layer: scheduled tasks targeting this runner MUST be created from config, not from the agent-callable scheduling tool.
- **`null`** — No-op, always returns `ok`. For testing only.

#### Scenario: Provider Uses Claude CLI Runner
- **GIVEN** A provider configured with `runner: { type: "claude-cli", workDir: "/code/signalfield" }`
- **WHEN** A webhook event is processed
- **THEN** The worker MUST spawn a `claude -p` subprocess with the rendered prompt, NOT call the OpenClaw gateway

#### Scenario: Provider Without Runner Config Uses OpenClaw
- **GIVEN** A provider with no `runner` field in its config
- **WHEN** A webhook event is processed
- **THEN** The worker MUST use the `openclaw` runner (backward compatible)

#### Scenario: Unknown Runner Type at Startup
- **GIVEN** A provider configured with `runner: { type: "unknown-runner" }`
- **WHEN** The proxy starts
- **THEN** Startup MUST fail with a Zod validation error identifying the unknown runner type

#### Scenario: Shell Runner Executes Command and Emits Lifecycle Events
- **GIVEN** A scheduled task fires with `runner: { type: "shell", command: "python3 ./tools/refresh_gmail_watch.py", timeoutMs: 60000 }`
- **WHEN** The worker invokes the shell runner
- **THEN** The runner MUST spawn the command as a child process, MUST emit `runner.tool_call` for the spawn (with the command captured), MUST capture stdout and stderr, AND MUST emit `runner.complete` if the process exits 0 within `timeoutMs` OR `runner.error` (with the captured stderr tail and exit code/signal) if the process exits non-zero, times out, or is signaled

#### Scenario: Shell Runner Times Out
- **GIVEN** A shell runner is invoked with `timeoutMs: 5000` and a command that hangs longer
- **WHEN** 5 seconds elapse without process exit
- **THEN** The runner MUST send `SIGTERM`, then `SIGKILL` after a short grace period if still running, AND MUST emit `runner.error` with a timeout reason


### Requirement: Configuration Schema

All configuration MUST be loaded from environment variables and validated at startup using a single Zod schema.

**Provider settings (via PROVIDERS_CONFIG JSON string):**

Each entry MAY include an optional `runner` field using a discriminated union schema. If absent, defaults to `openclaw`. Valid runner types: `openclaw`, `claude-cli`, `openai`, `bedrock`, `shell`, `null`.

The `shell` runner type schema requires:
- `command` (string, required) — the command to execute, parsed by the system shell
- `cwd` (string, optional) — working directory; defaults to the agent workspace directory
- `env` (record of string→string, optional) — extra environment variables, merged on top of the inherited env
- `timeoutMs` (integer, optional) — wall-clock timeout for the spawned process; defaults to 300000 (5 min)

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
  }
}
```

For `routing.schedule` rules in agent configs, the `runner` field on each rule MAY be specified to override the agent's default runner — this is how a config-defined scheduled task can target the `shell` runner for maintenance work without affecting the agent's webhook-driven runs.

#### Scenario: Shell Runner Config Validates
- **GIVEN** A `routing.schedule` rule with `runner: { type: "shell", command: "python3 ./tools/refresh_gmail_watch.py", timeoutMs: 60000 }`
- **WHEN** Clawndom starts and validates configuration
- **THEN** The Zod schema MUST accept the entry and the runtime MUST register a corresponding `ScheduledTask` record with `runner='shell'`

#### Scenario: Shell Runner Without Command Rejected
- **GIVEN** A `routing.schedule` rule with `runner: { type: "shell" }` and no `command`
- **WHEN** Clawndom starts
- **THEN** Zod validation MUST fail with a clear error identifying the missing `command` field on the offending rule
