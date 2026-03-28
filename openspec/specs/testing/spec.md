## Purpose

Defines the testing strategy and coverage requirements for the OpenClaw webhook proxy, ensuring that the completion-aware serialization gate is verified at unit, integration, and contract levels.

## Requirements

### Requirement: Test Framework and Configuration

All tests MUST use Vitest as the test runner with the following configuration:
- Node environment (not jsdom)
- Global test setup file for environment variables and singleton resets
- V8 coverage provider
- Coverage thresholds: 95% for statements, branches, functions, and lines
- Coverage exclusions limited to: test files, infrastructure scripts, and entry points (`server.ts`)

The `worker.service.ts` file MUST NOT be excluded from coverage thresholds. It contains the core serialization logic and MUST be tested.

#### Scenario: Coverage Threshold Violation
- **GIVEN** A PR reduces statement coverage to 93%
- **WHEN** CI runs `vitest run --coverage`
- **THEN** The test run MUST fail with a coverage threshold violation

### Requirement: Unit Tests — Signature Validation

Each signature validation strategy MUST have dedicated unit tests covering:
- Valid signature → passes
- Invalid signature (tampered body) → fails
- Missing signature header → fails
- Wrong signature prefix (e.g., `md5=` instead of `sha256=`) → fails
- Wrong signature length → fails
- Timing-safe comparison (no short-circuit on partial match)

Strategy tests MUST be isolated — they test the pure validation function, not the HTTP layer.

#### Scenario: WebSub Strategy Unit Test
- **GIVEN** A raw body buffer and a valid `sha256=<hex>` signature
- **WHEN** The websub strategy's validate function is called
- **THEN** It MUST return true

#### Scenario: GitHub Strategy Unit Test
- **GIVEN** A raw body buffer and a valid `sha256=<hex>` signature from the `X-Hub-Signature-256` header
- **WHEN** The github strategy's validate function is called
- **THEN** It MUST return true

### Requirement: Unit Tests — Worker Processing

The worker's `processJob` function MUST be tested with mocked HTTP and WebSocket dependencies:
- Successful flow: POST returns `{ ok: true, runId }` → `agent.wait` returns `{ status: "ok" }` → job completes
- POST failure: non-2xx response → job fails immediately (no `agent.wait` call)
- Missing runId: POST returns 200 but no runId → job fails
- agent.wait error: returns `{ status: "error" }` → job fails with error details
- agent.wait timeout: returns `{ status: "timeout" }` → job fails with timeout error

#### Scenario: Successful Processing
- **GIVEN** A mocked OpenClaw that returns `{ ok: true, runId: "test-run" }` and a mocked gateway that resolves `agent.wait` with `{ status: "ok" }`
- **WHEN** `processJob` is called with a webhook payload
- **THEN** The function MUST complete without error

#### Scenario: POST Failure
- **GIVEN** A mocked OpenClaw that returns 503
- **WHEN** `processJob` is called
- **THEN** The function MUST throw an error containing the status code

### Requirement: Unit Tests — Queue Service

Queue service tests MUST verify:
- Queue creation with correct name pattern (`webhooks:<provider>`)
- Singleton behavior (same queue instance on repeated calls for same provider)
- Different instances for different providers
- Redis connection sharing

#### Scenario: Provider Queue Name
- **GIVEN** A provider named "github"
- **WHEN** `getProviderQueue("github")` is called
- **THEN** The returned queue's name MUST be `webhooks:github`

### Requirement: Unit Tests — Concurrency Gate

The concurrency gate (Redis semaphore) MUST be tested with:
- Acquire when slots available → succeeds immediately
- Acquire when no slots available → blocks until released
- Release → increments available slots
- Release on error (cleanup) → slot is not leaked

These tests MUST use a real or mock Redis to verify atomic operations.

#### Scenario: Semaphore Blocks When Full
- **GIVEN** A semaphore with maxConcurrency=1 and one slot already acquired
- **WHEN** A second acquire is attempted
- **THEN** The acquire MUST block until the first slot is released

### Requirement: Integration Tests — End-to-End Flow

Integration tests MUST verify the full flow from HTTP ingress through queue processing to OpenClaw delivery. These tests MUST:
- Use real BullMQ queues (with a test Redis instance)
- Use a mock HTTP server for the OpenClaw endpoint
- Use a mock WebSocket server for the gateway `agent.wait` RPC
- Verify serialization: submit two events, confirm the second is not processed until the first completes

The mock OpenClaw server MUST:
- Accept POST requests with bearer auth
- Return `{ ok: true, runId }` with a unique runId per request
- Be configurable for error responses (503, 401, etc.)

The mock WebSocket server MUST:
- Accept `agent.wait` RPC calls
- Return terminal status after a configurable delay
- Support multiple concurrent `runId` waits

Integration tests MUST NOT hardcode ports. Use dynamic port allocation (port 0) to avoid conflicts with running services.

#### Scenario: Serialization Verification
- **GIVEN** A test proxy with one provider and a mock OpenClaw/gateway
- **WHEN** Two events are submitted in rapid succession
- **THEN** The mock MUST receive the second POST only after the first `agent.wait` returns

#### Scenario: Multi-Provider Independence
- **GIVEN** A test proxy with two providers (jira, github) and a mock gateway
- **WHEN** Both providers receive events simultaneously
- **THEN** Both events MUST be delivered to their respective OpenClaw hook URLs (subject to the global concurrency gate)

### Requirement: Contract Tests — Webhook Endpoint

HTTP-level tests MUST verify the webhook endpoint's external contract:
- Valid HMAC → 202 `{ accepted: true }`
- Invalid HMAC → 401 `{ error: "Invalid signature" }`
- Missing signature header → 401 `{ error: "Missing signature" }`
- Wrong signature prefix → 401 `{ error: "Invalid signature" }`
- Unregistered route → 404

These tests use `supertest` against the Express app with mocked queue service (no real Redis needed).

#### Scenario: Per-Provider Route Isolation
- **GIVEN** Jira is registered at `/hooks/jira` and GitHub at `/hooks/github`
- **WHEN** A request arrives at `/hooks/jira` with a valid Jira HMAC
- **THEN** The event MUST be enqueued in the `webhooks:jira` queue, not `webhooks:github`

### Requirement: Test Setup and Teardown

The global test setup MUST:
- Set `NODE_ENV=local`
- Set test values for all required environment variables (`JIRA_HMAC_SECRET`, `OPENCLAW_TOKEN`, etc.)
- Reset singleton caches (settings, queue instances, WebSocket connections) between tests via `beforeEach`
- Set `LOG_FORMAT=human` for readable test output

Integration tests that use Redis or BullMQ MUST clean up queues after each test to prevent cross-test contamination.

#### Scenario: Singleton Leak Between Tests
- **GIVEN** Test A configures a provider with secret "aaa"
- **WHEN** Test B runs without resetting singletons
- **THEN** Test B MUST NOT see Test A's secret — the setup MUST reset all cached state
