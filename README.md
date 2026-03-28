# clawndom

## Why

You've got OpenClaw agents reacting to external events — Jira transitions, GitHub pushes, Linear updates. The problem: these services don't send one webhook at a time. A Jira board reorganization fires 10 events in 2 seconds. A GitHub merge triggers webhooks for the push, the PR close, the deployment, and the status checks. Each event wakes an agent, each agent calls an LLM API, and suddenly you're rate-limited, runs are failing, and you're burning tokens on retries.

clawndom sits between your webhook sources and OpenClaw. It accepts events, validates them, and queues them — but the key thing is it **waits for each agent run to actually finish** before letting the next event through. Not "wait for OpenClaw to accept the POST" — wait for the agent to complete its work, send its messages, and go idle. One run at a time. No bursts. No rate limits. No wasted spend.

It also solves the auth gap: most webhook providers (Jira, GitHub) can't send bearer tokens. They sign payloads with HMAC instead. clawndom validates the signature, then forwards to OpenClaw with proper auth.

**Use clawndom if:**
- Your OpenClaw agents are triggered by external webhooks
- Those webhooks arrive in bursts (most do)
- You're hitting LLM API rate limits or seeing dropped/duplicate runs
- Your webhook source can't send bearer auth (needs HMAC validation)

**You don't need clawndom if:**
- Your agents are only triggered by chat messages or scheduled tasks
- You're running a single webhook source with low volume
- You're fine with fire-and-forget delivery (no completion tracking)

## How It Works

```
Third-Party Service (Jira, GitHub, etc.)
    │
    │  POST /hooks/:provider  (HMAC signature)
    ▼
Tailscale Funnel (public HTTPS → local port)
    │
    ▼
clawndom :8792
    │
    │  1. Validate HMAC signature (per-provider strategy)
    │  2. Enqueue in BullMQ (per-provider queue)
    │  3. Return 202
    │
    ▼
Redis (BullMQ queue: "webhooks:<provider>")
    │
    │  Worker (concurrency: 1 per provider, global semaphore)
    │
    ▼
OpenClaw Gateway :18789
    │  POST /hooks/agent  → { ok: true, runId }
    │  WS   agent.wait    → { status: "ok"|"error"|"timeout" }
    ▼
  Terminal state → release job → next event
```

### The Serialization Problem

External webhooks arrive in bursts. A Jira board transition can fire 5 events in 2 seconds. Each event triggers an OpenClaw agent run, and each run consumes Anthropic API tokens. Without throttling, bursts cause rate limiting, dropped runs, and wasted spend.

clawndom solves this by making the BullMQ worker completion-aware: it doesn't just fire-and-forget the POST to OpenClaw — it holds the job open until `agent.wait` confirms the run reached a terminal state. Only then does BullMQ dequeue the next event.

A Redis-backed global semaphore caps total concurrent runs across all providers (default: 1).

## Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable`)
- Redis (for BullMQ job queue and concurrency semaphore)
- Tailscale with Funnel enabled (to expose routes to external services)
- OpenClaw gateway running locally (default `127.0.0.1:18789`)

## Installation

```bash
git clone git@github.com:SC0RED/clawndom.git && cd clawndom
./install.sh
```

The installer prompts for secrets, builds the project, installs a launchd agent, and starts the proxy.

## Configuration

### Environment Variables

#### Required

| Variable | Description |
|---|---|
| `OPENCLAW_TOKEN` | Bearer token for OpenClaw API authentication |

#### Provider Secrets (at least one required)

| Variable | Description |
|---|---|
| `JIRA_HMAC_SECRET` | HMAC secret for Jira webhook signature validation |
| `GITHUB_HMAC_SECRET` | HMAC secret for GitHub webhook signature validation |

#### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8792` | HTTP server port |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL |
| `OPENCLAW_GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL for `agent.wait` RPC |
| `MAX_CONCURRENT_RUNS` | `1` | Global concurrency limit across all providers |
| `AGENT_WAIT_TIMEOUT_MS` | `1800000` | Timeout for `agent.wait` calls (30 min) |
| `NODE_ENV` | `development` | Environment name |
| `SERVICE_NAME` | `clawndom` | Service identifier for structured logging |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error, fatal) |
| `LOG_FORMAT` | `json` | Log format (json, human) |
| `PROVIDERS_CONFIG` | — | JSON array for multi-provider configuration (see below) |

#### Multi-Provider Configuration

For a single Jira provider, just set `JIRA_HMAC_SECRET`. For multiple providers, set `PROVIDERS_CONFIG` as a JSON string:

```json
[
  {
    "name": "jira",
    "routePath": "/hooks/jira",
    "hmacSecret": "...",
    "signatureStrategy": "websub",
    "openclawHookUrl": "http://127.0.0.1:18789/hooks/jira"
  },
  {
    "name": "github",
    "routePath": "/hooks/github",
    "hmacSecret": "...",
    "signatureStrategy": "github",
    "openclawHookUrl": "http://127.0.0.1:18789/hooks/agent"
  }
]
```

### Tailscale Funnel

Expose the proxy so external services can reach it:

```bash
tailscale funnel --bg --set-path /hooks/jira 8792
tailscale funnel --bg --set-path /hooks/github 8792
```

### launchd (macOS)

```bash
# Install
cp infra/launchd/com.openclaw.clawndom.plist ~/Library/LaunchAgents/
# Edit the plist to fill in INSTALL_PATH and env var values
launchctl load ~/Library/LaunchAgents/com.openclaw.clawndom.plist

# Uninstall
launchctl unload ~/Library/LaunchAgents/com.openclaw.clawndom.plist
rm ~/Library/LaunchAgents/com.openclaw.clawndom.plist
```

## Webhook Setup by Provider

### Jira

1. Jira Settings → System → WebHooks
2. URL: `https://<machine>.ts.net/hooks/jira`
3. Enable desired events
4. HMAC authentication with your `JIRA_HMAC_SECRET`
5. Jira sends `X-Hub-Signature: sha256=<hex>` (WebSub format)

### GitHub

1. Repo Settings → Webhooks → Add webhook
2. Payload URL: `https://<machine>.ts.net/hooks/github`
3. Content type: `application/json`
4. Secret: your `GITHUB_HMAC_SECRET`
5. GitHub sends `X-Hub-Signature-256: sha256=<hex>`

## Development

```bash
make dev          # Local server with hot reload
make check        # Lint + test + security + naming
make check-all    # Full validation (required before commit)
make format       # Auto-fix formatting
```

## Health Check

```
GET /api/health
```

Returns overall status plus individual checks for Redis, WebSocket gateway connection, and per-provider queue health.

```json
{
  "status": "healthy",
  "checks": [
    { "name": "redis", "status": "healthy" },
    { "name": "gateway-websocket", "status": "healthy" },
    { "name": "queue:jira", "status": "healthy" }
  ],
  "version": "0.2.0",
  "environment": "production",
  "timestamp": "2026-03-28T13:00:00.000Z"
}
```

## Specs

Architecture and behavior are defined in OpenSpec format under `openspec/specs/`:

| Spec | What it covers |
|---|---|
| `webhook-proxy-domain` | Core domain: ingestion, signature validation, queuing, completion-aware processing, concurrency |
| `testing` | Test strategy, coverage thresholds, mock patterns |
| `api-design` | HTTP response contracts (RFC 7807 errors) |
| `code-architecture` | Layered architecture, file size limits, dependency direction |
| `error-handling` | Exception hierarchy, structured error responses |
| `observability` | Structured logging, health checks |
| `infrastructure` | launchd, Tailscale, Redis deployment |
| `ci-cd` | GitHub Actions pipeline |
| `enforcement` | Pre-commit hooks, CI quality gates |
| `quality-framework` | Coverage thresholds, principles |
| `developer-experience` | Makefile, tooling, onboarding |
