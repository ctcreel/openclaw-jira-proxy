## Purpose

Defines the infrastructure requirements for deploying clawndom as a local macOS service with public webhook ingress via Tailscale Funnel.

## Requirements

### Requirement: launchd Service

The proxy MUST be deployable as a macOS launchd agent with:
- A plist template in `infra/launchd/` with placeholder values for secrets and paths
- `RunAtLoad: true` and `KeepAlive: true` for automatic restart on failure
- Structured log output to a known path (`/usr/local/var/log/clawndom.log`)
- Environment variables injected via plist `EnvironmentVariables` dict

The installer script (`install.sh`) MUST:
- Check for Node.js >= 22 and pnpm
- Prompt for required secrets (`OPENCLAW_TOKEN`, provider HMAC secrets)
- Build the project (`pnpm install && pnpm build`)
- Copy and configure the launchd plist with actual values
- Load the launchd agent

#### Scenario: Fresh Install
- **GIVEN** A macOS machine with Node.js 22+ and pnpm
- **WHEN** The user runs `./install.sh` and provides secrets
- **THEN** The proxy MUST be built, the plist installed, and the service running

#### Scenario: Missing Node.js
- **GIVEN** Node.js is not installed
- **WHEN** The installer runs
- **THEN** It MUST exit with a clear error before prompting for secrets

### Requirement: Tailscale Funnel

The proxy MUST be accessible from the public internet via Tailscale Funnel. Each provider route MUST be mapped to the proxy's port:

```bash
tailscale funnel --bg --set-path /hooks/jira <PORT>
tailscale funnel --bg --set-path /hooks/github <PORT>
```

The README MUST document Funnel setup. The health check MUST NOT depend on Funnel (it's an ingress concern, not an application concern).

#### Scenario: Funnel Route Mismatch
- **GIVEN** Tailscale Funnel maps `/hooks/jira` to port 8793
- **WHEN** The proxy listens on port 8792
- **THEN** Jira webhooks will return 502 — the README MUST document that the Funnel port must match the `PORT` env var

### Requirement: Redis Dependency

The proxy MUST require Redis for BullMQ queues and the global concurrency semaphore. Redis MUST be:
- Running on `127.0.0.1:6379` by default (configurable via `REDIS_URL`)
- Verified at startup — if Redis is unreachable, the proxy MUST fail fast with a clear error
- Monitored via the health endpoint (`GET /api/health`)

For macOS deployments, Redis is expected to run via Homebrew (`brew services start redis`).

#### Scenario: Redis Not Running
- **GIVEN** Redis is not running on the configured URL
- **WHEN** The proxy starts
- **THEN** It MUST fail with an error indicating Redis is unreachable

### Requirement: OpenClaw Gateway Dependency (Conditional)

The OpenClaw gateway is a required dependency ONLY when at least one provider is configured with `runner: { type: "openclaw" }` (or has no `runner` field, defaulting to `openclaw`).

When the `openclaw` runner is active:
- The proxy MUST connect to the OpenClaw gateway for HTTP forwarding and `agent.wait` WebSocket RPC
- Both endpoints default to `127.0.0.1:18789`
- The WebSocket URL is configurable via `OPENCLAW_GATEWAY_WS_URL`
- The proxy MUST NOT fail on startup if the gateway is temporarily unavailable — it MUST retry with exponential backoff

When NO provider uses the `openclaw` runner:
- No OpenClaw gateway connection MUST be attempted
- `OPENCLAW_GATEWAY_WS_URL` and `OPENCLAW_TOKEN` may be omitted from the plist
- The health check MUST NOT include a gateway connectivity check

#### Scenario: Gateway Temporarily Down (OpenClaw Runner Active)
- **GIVEN** The OpenClaw gateway is restarting and at least one provider uses the `openclaw` runner
- **WHEN** A webhook arrives and is enqueued
- **THEN** The worker MUST fail the job (gateway unreachable) and BullMQ MUST retry per its configured policy

#### Scenario: No OpenClaw Provider — No Gateway Required
- **GIVEN** All providers are configured with `runner: { type: "claude-cli", ... }`
- **WHEN** The proxy starts
- **THEN** No connection to the OpenClaw gateway MUST be attempted and startup MUST succeed without `OPENCLAW_GATEWAY_WS_URL`

### Requirement: Claude CLI Runner Environment

When any provider uses the `claude-cli` runner, the launchd plist MUST NOT set `ANTHROPIC_API_KEY` in its `EnvironmentVariables` dict. The Claude CLI authenticates via its own OAuth credentials stored in `~/.claude/`. If `ANTHROPIC_API_KEY` is present in the process environment, the CLI subprocess will bill to the API rather than the Max subscription — this is the operator's responsibility to prevent.

The `install.sh` script MUST NOT prompt for or set `ANTHROPIC_API_KEY`.

The `docs/guides/ENVIRONMENT_VARIABLES.md` MUST document this constraint explicitly.

#### Scenario: ANTHROPIC_API_KEY in Plist
- **GIVEN** The launchd plist sets `ANTHROPIC_API_KEY` in `EnvironmentVariables`
- **WHEN** The `claude-cli` runner spawns a subprocess
- **THEN** The subprocess inherits the env var and bills to the API, NOT the Max subscription — this MUST be documented as an operator error

#### Scenario: Clean Environment — Subscription Billing
- **GIVEN** `ANTHROPIC_API_KEY` is absent from the plist and the process environment
- **WHEN** The `claude-cli` runner spawns a subprocess
- **THEN** The subprocess authenticates via the CLI's stored OAuth credentials and bills to the Max subscription

### Requirement: Runner-Specific Prerequisites

The `install.sh` script MUST check prerequisites for all runner types referenced in `PROVIDERS_CONFIG`:

- **`openclaw`** runner: verify OpenClaw gateway is reachable at the configured URL
- **`claude-cli`** runner: verify `claude` binary is on PATH and authenticated (`claude /status`)
- **`openai`** runner: no additional binary prerequisite (stateless HTTP)
- **`bedrock`** runner: verify AWS credentials are available (`aws sts get-caller-identity`)

If a prerequisite check fails, the installer MUST warn the user and ask whether to proceed. It MUST NOT silently skip the check.

#### Scenario: Claude CLI Not Authenticated
- **GIVEN** The `claude` binary is on PATH but not authenticated to a Max subscription
- **WHEN** The installer runs with a `claude-cli` provider configured
- **THEN** The installer MUST warn that the CLI is not authenticated and prompt the user to run `claude login` before continuing
