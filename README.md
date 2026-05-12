# clawndom

The runtime that hosts sc0red's agent fleet — receives events, renders prompts, dispatches Claude / OpenAI / Bedrock runs against agent workspaces cloned from Git. Webhooks, scheduled tasks, internal task envelopes, and Slack Socket Mode all land here.

## What clawndom is

A long-running Node service that loads one or more **agent workspaces** at boot (each is a Git repo specified in `AGENTS_CONFIG`), reads each workspace's `clawndom.yaml` for routing rules, and dispatches every matching event into a per-agent BullMQ queue. The worker renders the rule's Nunjucks template, spawns the chosen runner (today the production runner is `claude-cli`), waits for the run to reach a terminal state, and emits structured audit + observability data the whole time.

Three dispatch surfaces, one engine:

- **Webhook** — third-party services POST to `/hooks/<provider>`. HMAC-validated per provider (`websub` for Jira, `github`, `slack`, `bearer` for trusted callers). Used by Jira, GitHub, Slack, Gmail Push.
- **Slack Socket Mode** — for Slack apps that need to receive `message.im`, `app_mention`, and assistant-thread events without a public ingress. Opened as an outbound WebSocket via `@slack/socket-mode`.
- **Scheduled / internal tasks** — `routing.schedule` rules fire on cron (BullMQ repeatable jobs). `/api/tasks` accepts a bearer-authenticated POST that dispatches a `taskType` against `routing.internal` rules. SPE-1981's registry stores durable schedule entries that survive a restart.

Each agent gets its own per-provider BullMQ queue; a Redis-backed global semaphore caps total concurrent runs across all providers (default 1) so a single Anthropic API key isn't spammed by parallel bursts.

## Architecture at a glance

```
Inbound:
    Webhook (Jira / GitHub / Slack / Gmail Push)
    Slack Socket Mode (WS, inbound only)
    POST /api/tasks (bearer)
    routing.schedule cron firings
              │
              ▼
    Match an agent + a rule via clawndom.yaml
              │
              ▼
    Render Nunjucks template + system-doc injections
              │
              ▼
    Enqueue on BullMQ queue (per agent + per provider)
              │
              │   Worker (concurrency 1 per provider, global semaphore)
              ▼
    Spawn runner (claude-cli today; openai / bedrock / shell / null also wired)
              │
              ▼
    Stream stdout, parse session JSON, write audit records,
    emit SSE events for the dashboard, hold the queue until
    the run reaches a terminal state.
```

The agent workspace is the source of truth for prompts, identity, and routing — clawndom is the dispatcher.

## SPE-2078 route-side tool-use

When a routing rule declares `tools:`, clawndom resolves each tool's `secrets:` via `SECRETS_CONFIG`, materializes a mode-600 credentials file inside a per-run temp directory, and registers a clawndom-tools MCP server with the spawned claude-cli via `--mcp-config`. The MCP server reads the credentials file at startup, unlinks it, and dispatches every `tool_use` block to the tool's `impl.py` over stdio JSON-RPC. Every dispatch lands a redacted audit record at `$CLAWNDOM_AUDIT_LOG`.

The literal credential value never enters the agent process's environment, the prompt context, or `/proc/<pid>/environ`. See `docs/REGULATED_BUYER_READINESS.md` for the full design.

## Agent workspaces

`AGENTS_CONFIG` lists one or more agents:

```json
[
  {
    "name": "winston",
    "repo": "git@github.com:ctcreel/winston-agency.git",
    "path": "workspaces/winston",
    "sharedTools": {
      "repo": "git@github.com:SC0RED/agency-tools.git",
      "ref": "v1.4.1",
      "path": "agency-tools"
    }
  }
]
```

At boot, clawndom clones each `repo` at `main` (or the pinned `ref`) under `CLAWNDOM_CONFIG_DIR`, plus the `sharedTools` repo as a sibling. Each agent's workspace exposes:

- `clawndom.yaml` — routing rules + per-rule tools + memory namespace declarations
- `templates/` — Nunjucks templates (one per route)
- `docs/` — `IDENTITY.md`, `SOUL.md`, and any policy / identity docs the templates inject
- `team.json` (Winston) or `workspaces/shared/docs/` (the-agency) — shared identity / reference data

A 5-minute systemd timer (`clawndom-sync-agents.timer` on the Patches box) `git pull`s each agent repo; pushes to `main` reach the agent without a clawndom restart. Winston's box doesn't run the timer — Winston restarts manually on config changes.

## Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable`)
- Redis (BullMQ job queue + concurrency semaphore + scheduled-tasks registry)
- Tailscale with Funnel enabled (HTTPS ingress for webhook providers)
- 1Password Service Account (resolves `SECRETS_CONFIG` references at boot via `op` CLI)
- A claude-cli binary on `$PATH` (default `/usr/bin/claude`) or a custom runner

## Installation

clawndom runs on a dedicated EC2 host in `sc0red-dev` (us-east-1). Infrastructure (VPC wiring, systemd units, Redis, Tailscale) is under `infra/ec2/` — `cloudformation.yaml` provisions a `t3.small` / `t3.medium`, `bootstrap.sh` sets it up, and GitHub Actions (`deploy-ec2.yml`) ships every push to `main` via `scripts/deploy.sh`.

For a new instance: deploy the CloudFormation stack, SSH in, run `infra/ec2/bootstrap.sh`, **register the per-instance SSH deploy key it prints as a read-only deploy key on `SC0RED/clawndom`** (Settings → Deploy keys → Add new — without this, `git fetch` from the `clawndom` user fails and the deploy workflow breaks), then follow the printed next steps (Tailscale up, populate `/etc/clawndom/clawndom.env`, `claude login`, `scripts/sync-agents.sh`, `scripts/deploy.sh`).

Winston's EC2 is provisioned the same way with its own `clawndom-winston.service` unit and a separate `/etc/clawndom-winston/clawndom.env`. The clawndom binary is shared; only the env file + workspace differ.

## Configuration

### Core env

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8792` | HTTP server port (production: `8793` Patches, `8794` Winston) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis URL for BullMQ + semaphore + registry |
| `CLAWNDOM_CONFIG_DIR` | — | Where agent workspaces are cloned at boot |
| `CLAWNDOM_AGENT_TOKEN` | — | Bearer token for `/api/tasks` + agent → memory writes |
| `MAX_CONCURRENT_RUNS` | `1` | Global concurrency cap across all providers |
| `AGENT_WAIT_TIMEOUT_MS` | `1800000` | Per-run timeout (30 min) |
| `CLAWNDOM_AUDIT_LOG` | `/var/log/clawndom-winston/audit.log` | Where SPE-2078 tool audit records land |
| `NODE_ENV` | `development` | `production` enables optimizations |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | Pino logger config |

> **systemd quoting:** every JSON-valued env var in `EnvironmentFile=` MUST be wrapped in single quotes or systemd silently drops it. The bundled `infra/ec2/validate-env.sh` (SPE-2000) catches this before deploy.

### `AGENTS_CONFIG`

JSON array. Each entry declares an agent's git source + optional `sharedTools`. Shape above.

### `PROVIDERS_CONFIG`

JSON array. Each entry declares one event ingress:

```json
[
  {
    "name": "jira",
    "routePath": "/hooks/jira",
    "signatureStrategy": "websub",
    "hmacSecret": "...",
    "runner": {
      "type": "claude-cli",
      "workDirectory": "/home/clawndom/.clawndom/agents/SC0RED__the-agency/workspaces/patch",
      "binary": "/usr/bin/claude"
    },
    "secrets": ["JIRA_HMAC"]
  },
  {
    "name": "slack-winston",
    "transport": "slack-socket",
    "contextStrategy": "slack",
    "appTokenSecret": "SLACK_WINSTON_APP_TOKEN",
    "botTokenSecret": "SLACK_WINSTON_BOT_TOKEN",
    "envSecrets": ["GCP_SERVICE_ACCOUNT_KEY", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
    "runner": { "type": "claude-cli", "workDirectory": "...", "binary": "/usr/bin/claude" }
  }
]
```

| Field | Purpose |
|---|---|
| `name` | Stable identifier — queue suffix, log facet, semaphore key |
| `routePath` | HTTP webhook path (omit for Slack Socket Mode) |
| `transport` | `webhook` (default) or `slack-socket` |
| `signatureStrategy` | `websub`, `github`, `slack`, or `bearer` |
| `hmacSecret` | Per-provider HMAC secret (or the bearer token for `bearer`) |
| `runner` | `{ type, workDirectory, binary }` — which runner + where to spawn |
| `secrets` | `SECRETS_CONFIG` keys the runner needs at boot validation |
| `envSecrets` | Keys injected into the agent subprocess env at run time |

### `SECRETS_CONFIG`

JSON array of `{ key, provider, reference }`. `provider: "onepassword"` looks up the secret via `op` CLI using the service account token in `OP_SERVICE_ACCOUNT_TOKEN`. Keys are `UPPER_CASE_ENV_VAR` style and must match the aliases in each tool's `tool.yaml` `secrets:` map.

### Tailscale Funnel

Each public path is allowlisted individually — there's no wildcard. Source of truth: [`infra/ec2/configure-tailscale-funnel.sh`](infra/ec2/configure-tailscale-funnel.sh). Re-run it on the box whenever the route list changes; the script resets and reapplies the full config so removed routes also disappear.

## Webhook provider setup

### Jira

1. Jira Settings → System → WebHooks
2. URL: `https://<machine>.ts.net/hooks/jira`
3. Authenticated via HMAC — Jira sends `X-Hub-Signature: sha256=<hex>` (WebSub format)

### GitHub

1. Repo Settings → Webhooks → Add webhook (or org-level for multi-repo)
2. Payload URL: `https://<machine>.ts.net/hooks/github`
3. Content type: `application/json`, secret: your `GITHUB_HMAC_SECRET`
4. GitHub sends `X-Hub-Signature-256: sha256=<hex>`

> Before configuring any new public webhook, add its `routePath` to `infra/ec2/configure-tailscale-funnel.sh` and re-run on the host.

### Slack (Socket Mode)

No public URL needed — clawndom opens a WebSocket outbound. Configure the Slack app with `app_mentions:read`, `chat:write`, `assistant:write`, plus per-channel `*:history` scopes for the read tools. App + bot tokens go into `SECRETS_CONFIG` as `SLACK_<AGENT>_APP_TOKEN` / `SLACK_<AGENT>_BOT_TOKEN`.

### Slack (HTTP webhook — legacy)

For non-Socket-Mode usage, route via `/hooks/slack` with Slack's `v0` signature strategy.

## Memory namespaces

Each agent's `clawndom.yaml` can declare memory namespaces it wants:

```yaml
memory:
  namespaces:
    winston-personal:
      embeddingProvider: openai
      vectorStore: redis
      pruneAfter: 365d
      maxStoresPerRun: 5
```

The agent calls `/api/memory/store`, `/api/memory/search`, and `/api/memory/delete` via the `agency_tools.memory` Python client (or curl). Pruning is access-LRU; `maxStoresPerRun` caps runaway-loop write amplification.

## Scheduled tasks

Two ways to fire on a clock:

1. **`routing.schedule` rules** in `clawndom.yaml` — declared at config time, fire via BullMQ repeatable jobs.
2. **`/api/scheduled-tasks` (SPE-1981 registry)** — agents POST a `{ when, runner, payload }` envelope; the registry persists it in Redis and BullMQ owns the timing. Survives a clawndom restart.

## Development

```bash
make dev          # Local server with hot reload (lint-quick first)
make check        # lint + test + test-infra + security + naming
make check-all    # check + sonar — required before commit
make format       # Auto-fix formatting
```

`make check-all` is the gate clawndom expects before any push to `main`. `make sonar` requires `SONAR_TOKEN` in env; it's non-blocking when run locally because the GitHub App also runs SonarCloud on every PR.

## Health check

```
GET /api/health
```

Returns overall status plus individual checks for application boot, secret manager readiness, and each registered runner.

```json
{
  "status": "healthy",
  "checks": [
    { "name": "application", "status": "healthy" },
    { "name": "secrets", "status": "healthy" },
    { "name": "runner:claude-cli", "status": "healthy" }
  ],
  "version": "0.2.0",
  "environment": "production",
  "timestamp": "2026-05-12T17:09:32.000Z"
}
```

## Specs

Architecture and behavior are defined in OpenSpec format under `openspec/specs/`:

| Spec | Covers |
|---|---|
| `webhook-proxy-domain` | Webhook ingestion, signature validation, queuing, completion-aware processing |
| `agent-runner-strategy` | Runner abstraction; how claude-cli / openai / bedrock plug in |
| `agent-tool-use` | SPE-2078 route-side tool-use, MCP bridge, credential confinement, audit |
| `agent-versioning` | How the audit log records the SHA of every agent repo for forensic replay |
| `infrastructure` | EC2, systemd, Tailscale, Redis deployment |
| `observability` | Pino structured logging, health checks, SSE event bus |
| `error-handling` | Exception hierarchy, structured error responses (RFC 7807) |
| `quality-framework` | Coverage thresholds, principles |
| `testing` | Test strategy, coverage thresholds, mock patterns |
| `developer-experience` | Makefile, tooling, onboarding |
| `enforcement` | Pre-commit hooks, CI quality gates |
| `ci-cd` | GitHub Actions pipeline |
| `api-design` | HTTP response contracts |
| `code-architecture` | Layered architecture, file size limits, dependency direction, runtime/application boundary |
