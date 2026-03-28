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
