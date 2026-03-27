# openclaw-jira-proxy

A lightweight Node.js/TypeScript proxy that receives Jira webhooks (which lack auth headers), validates their HMAC signature, queues them via BullMQ for serial processing, and forwards each event to an OpenClaw instance with a Bearer token. After forwarding, it monitors a WebSocket for run completion before processing the next event.

## Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable`)
- Redis (for BullMQ job queue)
- Tailscale with Funnel enabled (to expose the proxy to Jira)
- OpenClaw running locally (default `127.0.0.1:18789`)

## Installation

```bash
git clone <repo-url> && cd openclaw-jira-proxy
./install.sh
```

The installer prompts for secrets, builds the project, installs a launchd agent, and starts the proxy.

## Manual Setup

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_HMAC_SECRET` | Yes | — | Shared secret for Jira webhook HMAC verification |
| `OPENCLAW_TOKEN` | Yes | — | Bearer token for OpenClaw API |
| `OPENCLAW_HOOK_URL` | No | `http://127.0.0.1:18789/hooks/jira` | OpenClaw webhook endpoint |
| `REDIS_URL` | No | `redis://127.0.0.1:6379` | Redis connection URL for BullMQ |
| `PORT` | No | `8792` | Port the proxy listens on |
| `NODE_ENV` | No | `development` | Environment name |
| `SERVICE_NAME` | No | `openclaw-jira-proxy` | Service name for logging |
| `LOG_LEVEL` | No | `info` | Log level (debug, info, warn, error, fatal) |
| `LOG_FORMAT` | No | `json` | Log format (json, human) |

### launchd Commands

```bash
# Install
cp infra/launchd/com.openclaw.jira-proxy.plist ~/Library/LaunchAgents/
# Edit the plist to fill in INSTALL_PATH and env var values
launchctl load ~/Library/LaunchAgents/com.openclaw.jira-proxy.plist

# Uninstall
launchctl unload ~/Library/LaunchAgents/com.openclaw.jira-proxy.plist
rm ~/Library/LaunchAgents/com.openclaw.jira-proxy.plist
```

## Tailscale Funnel

Expose the proxy to the internet so Jira can reach it:

```bash
tailscale funnel --bg 8792
```

This gives you a public `https://<machine>.ts.net` URL to use as the Jira webhook endpoint.

## Jira Webhook Setup

1. Go to Jira Settings > System > WebHooks
2. Set the URL to `https://<machine>.ts.net/hooks/jira`
3. Enable the events you want to forward
4. Under authentication, configure HMAC with your `JIRA_HMAC_SECRET`
5. Jira sends `X-Hub-Signature-256: sha256=<hex>` on each request

## Architecture

```
Jira Cloud
    │
    │  POST /hooks/jira  (X-Hub-Signature-256)
    ▼
Tailscale Funnel
    │
    ▼
openclaw-jira-proxy :8792
    │
    │  1. Validate HMAC
    │  2. Enqueue in BullMQ
    │
    ▼
Redis (BullMQ queue: "jira-webhooks")
    │
    │  Worker (concurrency: 1)
    │
    ▼
OpenClaw :18789
    │  POST /hooks/jira  (Authorization: Bearer)
    │  WS   /            (wait for runId done)
    ▼
  Done → next job
```
