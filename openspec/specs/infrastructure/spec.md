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

### Requirement: OpenClaw Gateway Dependency

The proxy MUST connect to the OpenClaw gateway for:
- HTTP: forwarding webhook payloads to `/hooks/agent` or provider-specific hook URLs
- WebSocket: `agent.wait` RPC calls via persistent connection

Both endpoints default to `127.0.0.1:18789`. The WebSocket URL is configurable via `OPENCLAW_GATEWAY_WS_URL`.

The proxy MUST NOT fail on startup if the gateway is temporarily unavailable — it MUST retry WebSocket connection with exponential backoff. Jobs that cannot be forwarded due to gateway unavailability MUST fail and be retried by BullMQ.

#### Scenario: Gateway Temporarily Down
- **GIVEN** The OpenClaw gateway is restarting
- **WHEN** A webhook arrives and is enqueued
- **THEN** The worker MUST fail the job (gateway unreachable) and BullMQ MUST retry per its configured policy
