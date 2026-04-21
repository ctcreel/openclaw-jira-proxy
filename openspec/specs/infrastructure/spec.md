## Purpose

Defines the infrastructure requirements for deploying clawndom as a systemd service on a dedicated EC2 instance, with public webhook ingress via Tailscale Funnel.

## Requirements

### Requirement: systemd Service

The proxy MUST run as a systemd unit on Ubuntu (24.04 LTS) with:
- A unit file under `infra/ec2/systemd/clawndom.service`
- `Restart=on-failure` so the host supervises the process
- An `EnvironmentFile=/etc/clawndom/clawndom.env` to inject configuration
- `StandardOutput` and `StandardError` routed to journald
- A `clawndom` system user and `/opt/clawndom` checkout owned by that user

A companion `clawndom-sync-agents.timer` MUST periodically invoke `scripts/sync-agents.sh` (every 5 minutes) so agent-repo content is pulled without restarting the proxy.

#### Scenario: Fresh Instance
- **GIVEN** A fresh Ubuntu host provisioned from `infra/ec2/cloudformation.yaml`
- **WHEN** `infra/ec2/bootstrap.sh` is run as root
- **THEN** The `clawndom` user, systemd units, Redis, and Tailscale MUST be installed and the operator MUST be shown the remaining interactive steps (`claude login`, populating `/etc/clawndom/clawndom.env`)

#### Scenario: Rolling Deploy
- **GIVEN** The GitHub Actions workflow `deploy-ec2.yml` fires on a push to `main`
- **WHEN** It SSHes in and runs `sudo -u clawndom bash /opt/clawndom/scripts/deploy.sh`
- **THEN** The repo MUST be hard-reset to `origin/main`, dependencies installed, the project built, `systemctl restart clawndom` issued, and `/api/health` polled for a 200 before the workflow succeeds

### Requirement: Tailscale Funnel

The proxy MUST be accessible from the public internet via Tailscale Funnel. Each provider route and every `/api/*` endpoint the dashboard consumes MUST be registered explicitly — Funnel does not support wildcards.

```bash
tailscale funnel --bg --set-path /hooks/jira http://127.0.0.1:8793/hooks/jira
tailscale funnel --bg --set-path /api/health http://127.0.0.1:8793/api/health
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

On EC2, `redis-server` is installed and started by `bootstrap.sh` and bound to localhost.

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
- `OPENCLAW_GATEWAY_WS_URL` and `OPENCLAW_TOKEN` may be omitted from the environment
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

When any provider uses the `claude-cli` runner, the proxy environment (systemd unit or local shell) MUST NOT set `ANTHROPIC_API_KEY`. The Claude CLI authenticates via its own OAuth credentials stored in `~/.claude/`. If `ANTHROPIC_API_KEY` is present in the process environment, the CLI subprocess will bill to the API rather than the Max subscription — this is the operator's responsibility to prevent.

On EC2 the `clawndom-claude-refresh.timer` invokes `infra/ec2/refresh-claude-token.sh` every two hours to keep the credentials file alive; `claude -p` itself does not refresh in non-interactive sessions.

The `docs/guides/ENVIRONMENT_VARIABLES.md` MUST document these constraints explicitly.

#### Scenario: ANTHROPIC_API_KEY in Environment
- **GIVEN** The systemd unit or env file sets `ANTHROPIC_API_KEY`
- **WHEN** The `claude-cli` runner spawns a subprocess
- **THEN** The subprocess inherits the env var and bills to the API, NOT the Max subscription — this MUST be documented as an operator error

#### Scenario: Clean Environment — Subscription Billing
- **GIVEN** `ANTHROPIC_API_KEY` is absent from the environment
- **WHEN** The `claude-cli` runner spawns a subprocess
- **THEN** The subprocess authenticates via the CLI's stored OAuth credentials and bills to the Max subscription
