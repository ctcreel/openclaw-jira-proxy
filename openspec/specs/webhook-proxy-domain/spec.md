## Purpose

Defines the core domain behavior of the OpenClaw webhook proxy: a completion-aware serialization gate that accepts inbound webhooks from third-party platforms, validates their signatures, queues events, and forwards them to OpenClaw — waiting for each agent run to complete before processing the next event, ensuring downstream LLM API rate limits are never exceeded.

## Requirements

### Requirement: Multi-Provider Webhook Ingestion

The proxy MUST accept inbound webhooks from multiple third-party providers (e.g., Jira, GitHub, Linear). Each provider MUST be registered via configuration with:
- A unique provider name (used for routing, queue naming, and logging)
- A route path (e.g., `/hooks/jira`, `/hooks/github`)
- A signature validation strategy (header name, HMAC algorithm, signature format)
- A shared secret for HMAC verification
- An OpenClaw hook URL for forwarding (may vary per provider — e.g., `/hooks/agent` for direct dispatch, `/hooks/jira` for mapped hooks)

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

### Requirement: Completion-Aware Processing via agent.wait

The worker MUST NOT mark a job as complete until the corresponding OpenClaw agent run has reached a terminal state. The processing flow MUST be:

1. POST the event payload to the provider's configured OpenClaw hook URL with `Authorization: Bearer <token>` and `Content-Type: application/json`
2. Parse the response body — OpenClaw returns `{ ok: true, runId: "<string>" }` with status 200
3. Call the OpenClaw gateway's `agent.wait` JSON-RPC method via WebSocket with the `runId` and a configurable `timeoutMs` (default: 30 minutes)
4. `agent.wait` returns `{ status: "ok"|"error"|"timeout", startedAt, endedAt, error? }` when the run reaches a terminal state
5. If status is `"ok"`, mark the BullMQ job as completed
6. If status is `"error"`, mark the BullMQ job as failed with the error details
7. If status is `"timeout"`, mark the BullMQ job as failed with a timeout error

Only after the job is marked complete/failed does BullMQ pick up the next job from that provider's queue.

This is the core serialization mechanism. Because BullMQ worker concurrency is set to 1 per provider and jobs block on `agent.wait`, only one event per provider is actively consuming LLM API tokens at a time.

#### Scenario: Sequential Processing
- **GIVEN** Two Jira events are enqueued (Event A, Event B)
- **WHEN** Event A is delivered to OpenClaw and the agent run starts
- **THEN** Event B MUST NOT be delivered until Event A's `agent.wait` returns a terminal status

#### Scenario: Run Completes Successfully
- **GIVEN** An event is delivered and `agent.wait` returns `{ status: "ok" }`
- **WHEN** The worker processes the result
- **THEN** The BullMQ job MUST be marked as completed and the next job MUST be picked up

#### Scenario: Run Fails
- **GIVEN** An event is delivered and `agent.wait` returns `{ status: "error", error: "..." }`
- **WHEN** The worker processes the result
- **THEN** The BullMQ job MUST be marked as failed with the error message logged

#### Scenario: Run Times Out
- **GIVEN** An event is delivered and `agent.wait` returns `{ status: "timeout" }`
- **WHEN** The worker processes the result
- **THEN** The BullMQ job MUST be marked as failed with a timeout error and the next job MUST proceed

#### Scenario: OpenClaw Returns Non-2xx on POST
- **GIVEN** OpenClaw is temporarily unavailable and returns 503
- **WHEN** The worker attempts to forward an event
- **THEN** The job MUST fail immediately (no `agent.wait` call) and BullMQ's retry policy MUST govern redelivery

#### Scenario: OpenClaw Response Missing runId
- **GIVEN** OpenClaw returns 200 but the response body does not contain a `runId`
- **WHEN** The worker parses the response
- **THEN** The job MUST fail with an error indicating the missing runId

### Requirement: Gateway WebSocket Connection

The proxy MUST maintain a persistent WebSocket connection to the OpenClaw gateway for `agent.wait` RPC calls. The connection MUST:

- Connect to `ws://127.0.0.1:18789` (configurable via `OPENCLAW_GATEWAY_WS_URL`)
- Authenticate using the same bearer token used for HTTP hooks
- Reconnect automatically on disconnection with exponential backoff (base 1s, max 30s, jitter ±25%)
- Be shared across all provider workers (single connection, multiplexed RPC calls)

The `agent.wait` RPC MUST be called using the OpenClaw gateway's JSON-RPC protocol over WebSocket:
- Method: `"agent.wait"`
- Params: `{ runId: string, timeoutMs: number }`
- Response: `{ status: "ok"|"error"|"timeout", startedAt?: string, endedAt?: string, error?: string }`

If the WebSocket connection drops while an `agent.wait` call is in progress, the worker MUST:
1. Reconnect to the gateway
2. Re-issue `agent.wait` with the same `runId` — the gateway caches terminal snapshots, so a completed run will return immediately
3. If reconnection fails after exhausting retries, mark the job as failed with a connection error

The proxy MUST NOT re-POST the original event during WebSocket recovery. The run is already in progress — the only question is whether it has finished.

#### Scenario: WebSocket Drops Mid-Wait
- **GIVEN** The worker is waiting on `agent.wait` for run ID "abc123"
- **WHEN** The WebSocket connection drops
- **THEN** The worker MUST reconnect and re-issue `agent.wait` for "abc123"

#### Scenario: Gateway Caches Terminal State
- **GIVEN** Run "abc123" completed while the WebSocket was disconnected
- **WHEN** The worker reconnects and calls `agent.wait` for "abc123"
- **THEN** The gateway MUST return the cached terminal status immediately

#### Scenario: Reconnection Exhausted
- **GIVEN** The WebSocket cannot reconnect after all retry attempts
- **WHEN** The backoff is exhausted
- **THEN** The worker MUST mark the job as failed with a connection error

### Requirement: Global Concurrency Gate

The proxy MUST enforce a global concurrency limit that caps the total number of active OpenClaw runs across ALL providers. The global limit MUST be configurable via `MAX_CONCURRENT_RUNS` (default: 1).

The concurrency gate MUST be implemented as a Redis-backed semaphore. Before a worker begins processing a job (before the HTTP POST to OpenClaw), it MUST acquire a slot from the semaphore. The slot MUST be released when the job completes or fails (after `agent.wait` returns or on error).

When the global limit is reached, workers from all provider queues MUST wait until an active run completes before acquiring a slot and processing the next job.

#### Scenario: Global Limit Reached
- **GIVEN** Global concurrency is set to 1 and a Jira event is being processed
- **WHEN** A GitHub event is dequeued by its worker
- **THEN** The GitHub worker MUST wait for the Jira run to complete before acquiring the semaphore slot

#### Scenario: Global Limit of 2
- **GIVEN** Global concurrency is set to 2 and one run is active
- **WHEN** A new event is dequeued
- **THEN** The worker MUST acquire the second slot and process immediately

#### Scenario: Slot Release on Failure
- **GIVEN** A worker holds a semaphore slot and the run fails
- **WHEN** The job is marked as failed
- **THEN** The semaphore slot MUST be released so another worker can proceed

### Requirement: Agent Routing

The proxy MUST support configurable, per-provider routing rules that determine which OpenClaw agent receives each webhook event. Routing MUST use a Strategy pattern — each rule specifies a strategy name, a field path into the parsed payload, a match criterion, and a target `agentId`.

**Built-in strategies:**
- **`field-equals`** — Exact string match on a resolved field value. MUST support dot-notation field paths (e.g., `issue.fields.assignee.displayName`). If the resolved value is an array, the rule matches if ANY element equals the target value.
- **`regex`** — Regular expression match on a resolved field value. MUST support an optional `flags` field (e.g., `"i"` for case-insensitive). If the resolved value is an array, the rule matches if ANY element matches the pattern.
- **`default`** — Always matches. Used as the fallback. Takes no field or match criterion — only an `agentId`.

**Evaluation order:** Rules MUST be evaluated in array order. The first rule whose strategy returns a non-null `agentId` wins. If no rule matches and no `default` entry exists, the provider-level `defaultAgentId` is used. If that is also absent, the global `OPENCLAW_AGENT_ID` env var is used.

**Configuration:** Routing rules are defined per-provider in `PROVIDERS_CONFIG`:

```json
{
  "name": "jira",
  "routePath": "/hooks/jira",
  "hmacSecret": "...",
  "signatureStrategy": "websub",
  "routing": {
    "rules": [
      { "strategy": "field-equals", "field": "issue.fields.assignee.displayName", "value": "Patches", "agentId": "patch" },
      { "strategy": "regex", "field": "webhookEvent", "pattern": "^comment_", "flags": "i", "agentId": "main" }
    ],
    "default": "patch"
  }
}
```

If `routing` is omitted from a provider config, the provider MUST use the global `OPENCLAW_AGENT_ID` for all events (backward compatible).

**Strategy interface:**
```typescript
interface RoutingStrategy {
  readonly name: string;
  evaluate(payload: unknown, rule: RoutingRule): string | null;
}
```

Strategies MUST be registered in a routing strategy registry (mirroring the signature strategy registry pattern). Adding a new strategy MUST require only: (1) implementing the interface, (2) registering it by name.

#### Scenario: Field-Equals Match
- **GIVEN** A Jira webhook where `issue.fields.assignee.displayName` is `"Patches"`
- **WHEN** A `field-equals` rule matches on that field with value `"Patches"` and agentId `"patch"`
- **THEN** The event MUST be routed to agent `"patch"`

#### Scenario: Regex Match on Event Type
- **GIVEN** A Jira webhook where `webhookEvent` is `"jira:issue_updated"`
- **WHEN** A `regex` rule matches on `webhookEvent` with pattern `"^jira:issue_updated$"` and agentId `"patch"`
- **THEN** The event MUST be routed to agent `"patch"`

#### Scenario: Array Field Match
- **GIVEN** A Jira webhook where `issue.fields.labels` is `["infra", "urgent"]`
- **WHEN** A `regex` rule matches on `issue.fields.labels` with pattern `"infra"` and agentId `"sasha"`
- **THEN** The event MUST be routed to agent `"sasha"` (matched on array element `"infra"`)

#### Scenario: First Match Wins
- **GIVEN** Two rules: rule 1 matches assignee → agent `"patch"`, rule 2 matches event type → agent `"main"`
- **WHEN** Both rules would match the incoming payload
- **THEN** The event MUST be routed to agent `"patch"` (rule 1, first match)

#### Scenario: No Rules Match — Default Fallback
- **GIVEN** A provider with routing rules but none match the payload, and `routing.default` is `"patch"`
- **WHEN** The event is processed
- **THEN** The event MUST be routed to agent `"patch"` via the default fallback

#### Scenario: No Routing Config — Backward Compatible
- **GIVEN** A provider config with no `routing` key
- **WHEN** The event is processed
- **THEN** The event MUST be routed using the global `OPENCLAW_AGENT_ID`

#### Scenario: No Match and No Default — Skip
- **GIVEN** Routing rules that don't match and no `routing.default` and no global `OPENCLAW_AGENT_ID`
- **WHEN** The event is processed
- **THEN** The job MUST complete without forwarding and log a `routing:no-match` warning

### Requirement: Event Forwarding

The worker MUST forward events to OpenClaw by POSTing the original webhook payload to the provider's configured hook URL with:
- `Content-Type: application/json`
- `Authorization: Bearer <token>`

The request body MUST include:
- `message` — the original webhook payload (stringified)
- `agentId` — the resolved agent ID from routing
- `sessionKey` — a unique session key for the run (e.g., `hook:<provider>:<jobId>`)
- `deliver` — `false` (agent processes internally, does not echo to a channel)

The OpenClaw token MUST be shared across all providers (single OpenClaw instance). The token MUST be loaded from the `OPENCLAW_TOKEN` environment variable.

The response MUST be parsed as JSON. A successful response MUST contain `{ ok: true, runId: string }`. Any other response shape MUST be treated as an error.

#### Scenario: Successful Forwarding
- **GIVEN** OpenClaw is healthy
- **WHEN** The worker POSTs an event
- **THEN** The response MUST contain `{ ok: true, runId: "..." }` and the worker MUST proceed to `agent.wait`

#### Scenario: OpenClaw Returns 503
- **GIVEN** OpenClaw is temporarily unavailable
- **WHEN** The worker attempts to forward an event
- **THEN** The job MUST fail and BullMQ's retry policy MUST govern redelivery

### Requirement: Health Check with Dependency Status

The health endpoint (`GET /api/health`) MUST report the status of:
- **Application**: process is running
- **Redis**: connection is alive (ping check)
- **WebSocket**: gateway connection is established
- **Per-provider queue**: each registered provider's queue is responsive

Overall status aggregation:
- If Redis is down → `unhealthy` (503)
- If WebSocket is disconnected → `degraded` (200)
- If a provider queue is unresponsive → `degraded` (200)
- All checks pass → `healthy` (200)

Response MUST include: overall status, individual check results, service version, environment, and ISO 8601 timestamp.

#### Scenario: Redis Connection Lost
- **GIVEN** Redis becomes unreachable
- **WHEN** The health endpoint is called
- **THEN** The response MUST return 503 with status `unhealthy` and the Redis check marked as `unhealthy`

#### Scenario: WebSocket Disconnected
- **GIVEN** The gateway WebSocket is temporarily disconnected (reconnecting)
- **WHEN** The health endpoint is called
- **THEN** The response MUST return 200 with status `degraded` and the WebSocket check marked as `degraded`

### Requirement: Job Retention and Observability

Completed jobs MUST be retained for a configurable count (default: 100 per provider). Failed jobs MUST be retained for a configurable count (default: 100 per provider).

All job lifecycle events MUST be logged with structured fields:
- `provider`: provider name (e.g., "jira", "github")
- `jobId`: BullMQ job ID
- `runId`: OpenClaw run ID (when available)
- `status`: terminal status from `agent.wait` (when available)
- `durationMs`: total processing time from dequeue to completion

Log levels:
- Job enqueued → `info`
- Job processing started → `info`
- Job completed → `info` (with `durationMs`)
- Job failed → `error` (with error details)
- WebSocket reconnection → `warn`
- Signature validation failure → `warn`

#### Scenario: Job Completion Logging
- **GIVEN** A Jira event is successfully processed
- **WHEN** The job completes
- **THEN** A structured log entry MUST include: provider "jira", job ID, run ID, agent.wait status "ok", and processing duration in milliseconds

#### Scenario: Job Failure Logging
- **GIVEN** A GitHub event fails because OpenClaw returned 503
- **WHEN** The job is marked as failed
- **THEN** A structured log entry MUST include: provider "github", job ID, HTTP status 503, and error message

### Requirement: Configuration Schema

All configuration MUST be loaded from environment variables and validated at startup using a single Zod schema. The schema MUST include:

**Global settings:**
- `NODE_ENV` — environment name (local, development, testing, demo, production; default: development)
- `PORT` — HTTP server port (default: 8792)
- `SERVICE_NAME` — service identifier for logging (default: "openclaw-webhook-proxy")
- `LOG_LEVEL` — pino log level (default: info)
- `LOG_FORMAT` — output format: json or human (default: json)
- `REDIS_URL` — Redis connection string (default: redis://127.0.0.1:6379)
- `OPENCLAW_TOKEN` — bearer token for OpenClaw API (required)
- `OPENCLAW_GATEWAY_WS_URL` — WebSocket URL for gateway RPC (default: ws://127.0.0.1:18789)
- `MAX_CONCURRENT_RUNS` — global concurrency limit (default: 1)
- `AGENT_WAIT_TIMEOUT_MS` — default timeout for agent.wait calls (default: 1800000 / 30 minutes)

**Provider settings (via PROVIDERS_CONFIG JSON string, required):**

All providers are defined uniformly via `PROVIDERS_CONFIG`. There are no hardcoded providers or per-provider env vars. Each entry in the JSON array MUST include:
- `name` — unique provider identifier (used for queue naming and logging)
- `routePath` — inbound route path (e.g., `/hooks/jira`)
- `hmacSecret` — shared secret for HMAC signature validation
- `signatureStrategy` — name of the signature validation strategy (e.g., `"websub"`, `"github"`)
- `openclawHookUrl` — target URL for forwarding validated events

#### Scenario: Single Provider
- **GIVEN** `PROVIDERS_CONFIG` contains one provider entry for Jira
- **WHEN** The proxy starts
- **THEN** It MUST register a single route, queue, and worker for Jira

#### Scenario: Multi-Provider Configuration
- **GIVEN** `PROVIDERS_CONFIG` contains entries for Jira and GitHub
- **WHEN** The proxy starts
- **THEN** Both providers MUST be registered with their respective routes, secrets, and strategies

#### Scenario: Missing PROVIDERS_CONFIG
- **GIVEN** `PROVIDERS_CONFIG` is not set
- **WHEN** The proxy starts
- **THEN** It MUST fail with a clear error indicating no providers are configured
