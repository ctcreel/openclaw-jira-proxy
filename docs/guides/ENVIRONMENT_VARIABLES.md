# Environment Variables

## Required

| Variable | Description |
|----------|-------------|
| `OPENCLAW_TOKEN` | Bearer token for OpenClaw API authentication |

At least one provider secret is also required (e.g., `JIRA_HMAC_SECRET`).

## Application

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Runtime environment (local, development, testing, demo, production) |
| `PORT` | `8792` | HTTP server port |
| `SERVICE_NAME` | `clawndom` | Service identifier for structured logs |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error, fatal) |
| `LOG_FORMAT` | `json` | Log format (json, human) |

## Infrastructure

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL for BullMQ and concurrency semaphore |
| `OPENCLAW_GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL for `agent.wait` RPC |

## Concurrency

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_RUNS` | `1` | Global concurrency limit across all providers |
| `AGENT_WAIT_TIMEOUT_MS` | `1800000` | Timeout for `agent.wait` calls (30 minutes) |

## Provider Configuration

All providers are configured via a single env var:

| Variable | Required | Description |
|----------|----------|-------------|
| `PROVIDERS_CONFIG` | Yes | JSON array of provider objects (see README for schema) |

Each provider object defines: name, route path, HMAC secret, signature strategy, and OpenClaw hook URL. There are no per-provider env vars — everything lives in `PROVIDERS_CONFIG`.

## Validation

All environment variables are validated at startup using a Zod schema in `src/config.ts`. Missing required variables cause a fast failure with a clear error message identifying the missing field.

## systemd EnvironmentFile parsing — quote your JSON values

> Background: SPE-2000 — production failed to start because JSON values in `/etc/clawndom/clawndom.env` were unquoted and systemd silently dropped them.

systemd's `EnvironmentFile=` directive parses the file using POSIX-shell-style quoting rules. Unquoted values containing literal `"` characters get the quote chars stripped during parse, so any JSON-valued env var written without single quotes around it reaches the running process **either malformed or empty**. The Zod schema then errors with `"At least one provider must be configured"`, the service fails to start, and the cause is invisible — `systemctl show -p Environment` reports nothing for the dropped key.

The fix is to wrap every JSON-valued env var in **single quotes**. systemd takes single-quoted values literally, so the JSON survives intact.

### Affected env vars

| Variable | Required quoting |
|----------|------------------|
| `PROVIDERS_CONFIG` | single quotes |
| `AGENTS_CONFIG` | single quotes |
| `SECRETS_PROVIDERS_CONFIG` | single quotes |
| `SECRETS_CONFIG` | single quotes |

### Working example

```
# WRONG — systemd will silently drop or mangle this value:
PROVIDERS_CONFIG=[{"name":"jira","routePath":"/hooks/jira","hmacSecret":"x","signatureStrategy":"websub","openclawHookUrl":"http://127.0.0.1:18789/hooks/jira"}]

# RIGHT — single-quoted, JSON survives parse intact:
PROVIDERS_CONFIG='[{"name":"jira","routePath":"/hooks/jira","hmacSecret":"x","signatureStrategy":"websub","openclawHookUrl":"http://127.0.0.1:18789/hooks/jira"}]'
```

Note: do **not** use double quotes around JSON values. Double-quoted values in `EnvironmentFile=` honor backslash escapes and require escaping every `"` inside the JSON, which is fragile. Single quotes are taken literally — use them.

### Self-check before you restart the service

After editing `/etc/clawndom/clawndom.env`, validate it with the bundled checker:

```bash
sudo bash /opt/clawndom/infra/ec2/validate-env.sh
```

The script asks systemd to parse the file via a transient unit and asserts that each of the four JSON-valued env vars survives the round-trip as a non-empty JSON array. On failure it names the offending key and the operator-facing fix. `scripts/deploy.sh` runs the same check before `systemctl restart clawndom.service`, so a bad env file fails the deploy with a clear message instead of leaving the service stopped.
