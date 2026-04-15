## Purpose

Defines the core domain behavior of the OpenClaw webhook proxy: a completion-aware serialization gate that accepts inbound webhooks from third-party platforms, validates their signatures, queues events, and delivers them to a configured agent runner — waiting for each run to complete before processing the next event, ensuring downstream LLM API rate limits are never exceeded.

## Requirements

### Requirement: Multi-Provider Webhook Ingestion

The proxy MUST accept inbound webhooks from multiple third-party providers (e.g., Jira, GitHub, Linear). Each provider MUST be registered via configuration with:
- A unique provider name (used for routing, queue naming, and logging)
- A route path (e.g., `/hooks/jira`, `/hooks/github`)
- A signature validation strategy (header name, HMAC algorithm, signature format)
- A shared secret for HMAC verification
- An OpenClaw hook URL for forwarding (required when using the `openclaw` runner; may be omitted for other runner types)

Provider configuration MUST be validated at startup using Zod schema validation. The proxy MUST fail fast if any required field is missing or invalid, with a clear error identifying the misconfigured provider.

#### Scenario: Registered Provider Receives Webhook
- **GIVEN** A provider "jira" is registered with route path `/hooks/jira`
- **WHEN** A POST request arrives at `/hooks/jira` with a valid HMAC signature
- **THEN** The proxy MUST accept the event (202) and enqueue it for processing

#### Scenario: Unregistered Route
- **GIVEN** No provider is registered for `/hooks/slack`
- **WHEN** A POST request arrives at `/hooks/slack`
- **THEN** The proxy MUST return 404

#### Scenario: Missing Provider Configuration
- **GIVEN** A provider config entry is missing the HMAC secret
- **WHEN** The proxy starts up
- **THEN** The proxy MUST throw a Zod validation error identifying the missing field and provider name

### Requirement: Signature Validation Strategy

The proxy MUST support multiple HMAC signature formats through a Strategy pattern. Each strategy is a pure function that extracts and validates a signature from HTTP headers. At minimum:
- **WebSub format** (Jira): Header `X-Hub-Signature`, value `sha256=<hex>`
- **GitHub format**: Header `X-Hub-Signature-256`, value `sha256=<hex>`

Each provider's config MUST specify which strategy to use by name (e.g., `"websub"`, `"github"`). Signature validation MUST use timing-safe comparison via `crypto.timingSafeEqual`. Invalid or missing signatures MUST result in a 401 response with an RFC 7807-compliant error body.

#### Scenario: Valid Jira Signature (WebSub Strategy)
- **GIVEN** A Jira webhook with header `X-Hub-Signature: sha256=<valid-hex>`
- **WHEN** The proxy validates using the "websub" strategy
- **THEN** Validation MUST pass and the event MUST be enqueued

#### Scenario: Valid GitHub Signature
- **GIVEN** A GitHub webhook with header `X-Hub-Signature-256: sha256=<valid-hex>`
- **WHEN** The proxy validates using the "github" strategy
- **THEN** Validation MUST pass and the event MUST be enqueued

#### Scenario: Invalid Signature
- **GIVEN** A webhook with a tampered body but original signature
- **WHEN** The proxy validates the signature
- **THEN** Validation MUST fail and the proxy MUST return 401

#### Scenario: Missing Signature Header
- **GIVEN** A webhook request with no signature header
- **WHEN** The proxy checks for the signature
- **THEN** The proxy MUST return 401 with error "Missing signature"

### Requirement: Per-Provider Queue Isolation

Each registered provider MUST have its own BullMQ queue. Queue names MUST follow the pattern `webhooks:<provider-name>` (e.g., `webhooks:jira`, `webhooks:github`). Provider queues MUST be independent — a stalled job in one provider's queue MUST NOT block processing of another provider's events.

Each queue MUST share a single Redis connection managed by a connection factory. Queue creation MUST be lazy (created on first use) and cached for subsequent calls.

#### Scenario: Jira Queue Stalled
- **GIVEN** The `webhooks:jira` queue has a stalled job
- **WHEN** A GitHub webhook arrives and is enqueued in `webhooks:github`
- **THEN** The GitHub event MUST be processed independently of the Jira queue

#### Scenario: Queue Name Derivation
- **GIVEN** A provider named "github" is registered
- **WHEN** Its queue is created
- **THEN** The BullMQ queue name MUST be `webhooks:github`

### Requirement: Completion-Aware Processing via Agent Runner

The worker MUST NOT mark a job as complete until the corresponding agent run has reached a terminal state. The processing flow MUST be:

1. Resolve the agent runner for the provider (from the runner registry, using `provider.runner.type` or defaulting to `openclaw`)
2. Render the message template against the webhook payload
3. Call `runner.run({ prompt, sessionKey, agentId, model, timeoutMs })`
4. The runner returns `{ status: "ok" | "error" | "timeout", renderedPrompt, ... }`
5. If status is `"ok"`, mark the BullMQ job as completed
6. If status is `"error"`, mark the BullMQ job as failed with the error details
7. If status is `"timeout"`, mark the BullMQ job as failed with a timeout error

Only after the job is marked complete/failed does BullMQ pick up the next job from that provider's queue.

This is the core serialization mechanism. Because BullMQ worker concurrency is set to 1 per provider and jobs block on `runner.run`, only one event per provider is actively consuming LLM tokens at a time.

#### Scenario: Sequential Processing
- **GIVEN** Two Jira events are enqueued (Event A, Event B)
- **WHEN** Event A is delivered to the runner and the run starts
- **THEN** Event B MUST NOT be delivered to the runner until Event A's run returns a terminal status

#### Scenario: Run Completes Successfully
- **GIVEN** An event is delivered and the runner returns `{ status: "ok" }`
- **WHEN** The worker processes the result
- **THEN** The BullMQ job MUST be marked as completed and the next job MUST be picked up

#### Scenario: Run Fails
- **GIVEN** An event is delivered and the runner returns `{ status: "error", error: "..." }`
- **WHEN** The worker processes the result
- **THEN** The BullMQ job MUST be marked as failed with the error message logged

#### Scenario: Run Times Out
- **GIVEN** An event is delivered and the runner returns `{ status: "timeout" }`
- **WHEN** The worker processes the result
- **THEN** The BullMQ job MUST be marked as failed with a timeout error and the next job MUST proceed

### Requirement: Agent Runner Abstraction

The worker MUST NOT depend directly on any concrete runner implementation. All prompt delivery MUST go through the `AgentRunner` interface. The runner for a provider MUST be resolved from the runner registry using `provider.runner.type` (defaulting to `"openclaw"` if absent).

Runners MUST be registered at startup before any worker processes jobs. An unknown runner type in `PROVIDERS_CONFIG` MUST cause startup to fail with a clear error.

Built-in runner types:
- **`openclaw`** — Delivers via OpenClaw gateway RPC (`agent.wait`). Default when `runner` is absent.
- **`claude-cli`** — Spawns `claude -p` subprocess. Requires `workDir`.
- **`openai`** — Calls OpenAI `/v1/chat/completions`. Requires `model` and `apiKey`.
- **`bedrock`** — Calls AWS Bedrock `InvokeModel`. Requires `modelId` and `region`. Uses ambient AWS credentials.
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

### Requirement: Prompt Observability

Every agent run MUST produce a structured log entry capturing what was delivered to the runner. The log MUST be emitted at two levels:

- **`info` level**: `promptHash` (first 12 hex chars of SHA-256), `promptLength`, `runner`, `sessionKey`, `provider`, `jobId`
- **`debug` level**: All `info` fields plus the full `renderedPrompt`

The `renderedPrompt` MUST be captured from `RunResult.renderedPrompt` — the runner is responsible for returning what it actually sent, not what the worker prepared.

A `scripts/preview-template.ts` script MUST be provided for authoring-time template preview. It MUST accept `--template <path>` and `--payload <path>` arguments, render the template against the payload, and write the result to stdout. It MUST NOT make any network calls or invoke any runner.

#### Scenario: Debug Logging Captures Full Prompt
- **GIVEN** `LOG_LEVEL=debug` is set
- **WHEN** An agent run completes
- **THEN** The log MUST include the full rendered prompt delivered to the runner

#### Scenario: Info Logging Does Not Leak Payload
- **GIVEN** `LOG_LEVEL=info` is set (production default)
- **WHEN** An agent run completes
- **THEN** The log MUST include only `promptHash` and `promptLength` — no payload content

#### Scenario: Template Preview
- **GIVEN** A template file and a sample JSON payload file
- **WHEN** `make preview-template TEMPLATE=<path> PAYLOAD=<path>` is run
- **THEN** The rendered template MUST be printed to stdout with no network calls

### Requirement: Gateway WebSocket Connection

This requirement applies only when at least one provider uses the `openclaw` runner. If no provider uses the `openclaw` runner, the gateway WebSocket connection MUST NOT be established and MUST NOT appear in health checks.

When the `openclaw` runner is active, the proxy MUST maintain a persistent WebSocket connection to the OpenClaw gateway. The connection MUST:

- Connect to `ws://127.0.0.1:18789` (configurable via `OPENCLAW_GATEWAY_WS_URL`)
- Authenticate using the same bearer token used for HTTP hooks
- Reconnect automatically on disconnection with exponential backoff (base 1s, max 30s, jitter ±25%)
- Be shared across all provider workers using the `openclaw` runner

The `agent.wait` RPC MUST be called using the OpenClaw gateway's JSON-RPC protocol over WebSocket:
- Method: `"agent.wait"`
- Params: `{ runId: string, timeoutMs: number }`
- Response: `{ status: "ok"|"error"|"timeout", startedAt?: string, endedAt?: string, error?: string }`

#### Scenario: WebSocket Drops Mid-Wait
- **GIVEN** The openclaw runner is waiting on `agent.wait` for run ID "abc123"
- **WHEN** The WebSocket connection drops
- **THEN** The runner MUST reconnect and re-issue `agent.wait` for "abc123"

#### Scenario: No OpenClaw Provider — No Gateway Connection
- **GIVEN** All providers are configured with `runner: { type: "claude-cli", ... }`
- **WHEN** The proxy starts
- **THEN** No WebSocket connection to the OpenClaw gateway MUST be attempted

### Requirement: Global Concurrency Gate

The proxy MUST enforce a global concurrency limit that caps the total number of active runs across ALL providers and ALL runner types. The global limit MUST be configurable via `MAX_CONCURRENT_RUNS` (default: 1).

The concurrency gate MUST be implemented as a Redis-backed semaphore. Before a worker begins processing a job, it MUST acquire a slot. The slot MUST be released when the job completes or fails.

#### Scenario: Global Limit Reached
- **GIVEN** Global concurrency is set to 1 and a Jira event is being processed by the `claude-cli` runner
- **WHEN** A GitHub event is dequeued by its worker
- **THEN** The GitHub worker MUST wait for the Jira run to complete before acquiring the semaphore slot

#### Scenario: Slot Release on Failure
- **GIVEN** A worker holds a semaphore slot and the runner returns `status: "error"`
- **WHEN** The job is marked as failed
- **THEN** The semaphore slot MUST be released so another worker can proceed

### Requirement: Agent Routing

The proxy MUST support configurable, per-provider routing rules that determine which OpenClaw agent receives each webhook event. Routing rules are evaluated before runner invocation and supply the `agentId` passed to `runner.run()`.

Routing is runner-agnostic — all runner types receive the resolved `agentId`. For runners that do not support multi-agent dispatch (e.g., `claude-cli`, `openai`, `bedrock`), `agentId` is available for inclusion in the prompt template or system prompt but does not affect the execution target.

Built-in strategies: `field-equals`, `regex`, `default`. Evaluation order: rules in array order, then `routing.default`, then global `OPENCLAW_AGENT_ID`.

### Requirement: Event Forwarding (OpenClaw Runner Only)

When the `openclaw` runner is used, the runner MUST forward events to OpenClaw by POSTing the rendered prompt to the provider's configured `openclawHookUrl` with:
- `Content-Type: application/json`
- `Authorization: Bearer <token>`

The request body MUST include `message`, `agentId`, `sessionKey`, and `deliver: false`.

For all other runner types, there is no HTTP forwarding — the runner executes the prompt directly.

### Requirement: Health Check with Dependency Status

The health endpoint (`GET /api/health`) MUST report the status of:
- **Application**: process is running
- **Redis**: connection is alive (ping check)
- **Per-runner**: one check per registered runner that implements `isHealthy()`, named `runner:<type>` (e.g., `runner:openclaw`, `runner:claude-cli`)
- **Per-provider queue**: each registered provider's queue is responsive

Overall status aggregation:
- If Redis is down → `unhealthy` (503)
- If any runner reports unhealthy → `degraded` (200)
- If a provider queue is unresponsive → `degraded` (200)
- All checks pass → `healthy` (200)

#### Scenario: Claude CLI Runner Binary Missing
- **GIVEN** A provider uses the `claude-cli` runner and the `claude` binary is not on PATH
- **WHEN** The health endpoint is called
- **THEN** The response MUST return 200 with status `degraded` and `runner:claude-cli` marked as `degraded`

#### Scenario: No OpenClaw Provider
- **GIVEN** No provider uses the `openclaw` runner
- **WHEN** The health endpoint is called
- **THEN** The response MUST NOT include a `runner:openclaw` check

### Requirement: Job Retention and Observability

Completed jobs MUST be retained for a configurable count (default: 100 per provider). Failed jobs MUST be retained for a configurable count (default: 100 per provider).

All job lifecycle events MUST be logged with structured fields:
- `provider`: provider name
- `jobId`: BullMQ job ID
- `runner`: runner type used (e.g., "openclaw", "claude-cli")
- `sessionKey`: session key for the run
- `promptHash`: first 12 hex chars of SHA-256 of rendered prompt (info level and above)
- `promptLength`: character count of rendered prompt (info level and above)
- `status`: terminal status from runner (when available)
- `durationMs`: total processing time from dequeue to completion

### Requirement: Configuration Schema

All configuration MUST be loaded from environment variables and validated at startup using a single Zod schema.

**Provider settings (via PROVIDERS_CONFIG JSON string):**

Each entry MAY include an optional `runner` field using a discriminated union schema. If absent, defaults to `openclaw`. Valid runner types: `openclaw`, `claude-cli`, `openai`, `bedrock`, `null`.

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
