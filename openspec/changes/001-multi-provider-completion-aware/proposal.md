## Title

Multi-Provider Support with Completion-Aware Backpressure

## Problem

The proxy is hardcoded to Jira: single HMAC header, single queue, single route. Adding any new webhook source requires modifying core files. More critically, the worker does fire-and-forget delivery (POST → check status → done) without waiting for the OpenClaw agent run to complete. This defeats the core purpose — serializing webhook-triggered agent runs to prevent LLM API rate limiting. Events drain at network speed, not at run-completion speed.

## Solution

### 1. Provider Registry (Strategy Pattern)

Replace hardcoded Jira references with a config-driven provider registry. Each provider declares:
- Route path, signature header, HMAC algorithm, shared secret
- Target OpenClaw hook URL
- Concurrency (how many simultaneous runs allowed)

Providers are loaded at startup from environment variables or a config file. Each provider gets its own BullMQ queue (`webhooks:<name>`), its own route, and its own worker pool.

### 2. Signature Validation Strategies

Extract HMAC validation into a Strategy interface. Ship two implementations:
- **WebSub** (Jira): `X-Hub-Signature: sha256=<hex>`
- **GitHub**: `X-Hub-Signature-256: sha256=<hex>`

New providers are added by implementing the strategy interface (or reusing an existing one with different config).

### 3. Completion-Aware Worker

The worker currently POSTs to OpenClaw and considers the job done on 2xx. This must change to:
1. POST event → receive run ID from OpenClaw response
2. Connect to OpenClaw WebSocket
3. Wait for run terminal state (completed / failed / timed out)
4. Only then mark the BullMQ job as complete

This is the critical missing piece. Without it, concurrency: 1 doesn't actually serialize runs — it serializes HTTP requests, which is not the same thing.

### 4. Health Check Enhancement

Add Redis connectivity and per-provider queue health to the `/api/health` endpoint. Currently only checks that the process is alive.

## Affected Specs

- **webhook-proxy-domain** (new) — defines all new domain behavior
- **code-architecture** — no changes needed, already supports Strategy pattern and layered architecture
- **api-design** — no changes needed, new routes follow existing patterns
- **observability** — health check enhancement aligns with existing spec requirements
- **error-handling** — no changes needed, retry and error boundary patterns apply

## Files Affected

### New Files
- `src/providers/types.ts` — Provider interface, signature strategy interface
- `src/providers/registry.ts` — Provider registry, config loading
- `src/providers/strategies/websub.ts` — WebSub HMAC validation (Jira)
- `src/providers/strategies/github.ts` — GitHub HMAC validation
- `src/services/completion.service.ts` — WebSocket completion tracking with reconnect + REST poll fallback
- `src/services/concurrency.service.ts` — Global concurrency gate (shared across all provider workers)

### Modified Files
- `src/config.ts` — Replace `jiraHmacSecret` with provider config schema
- `src/routes/index.ts` — Dynamic route registration from provider registry
- `src/controllers/webhook.controller.ts` — Accept provider context, delegate to strategy
- `src/services/queue.service.ts` — Per-provider queue creation
- `src/services/worker.service.ts` — Completion-aware processing loop
- `src/services/health.service.ts` — Redis + queue health checks
- `src/server.ts` — Initialize provider registry and per-provider workers
- `src/types.ts` — New health check types for dependencies

### Config/Docs
- `README.md` — Updated architecture, multi-provider config examples
- `CLAUDE.md` — Updated patterns table
- `docs/guides/ENVIRONMENT_VARIABLES.md` — New provider config vars

## Estimation

- **Risk:** Medium — completion tracking via WebSocket is new behavior with failure modes (WS disconnect, run timeout, OpenClaw restart)
- **Intensity:** Medium — touches most files but each change is focused; no business logic ambiguity
- **Story Points:** 5
- **Phases:**
  1. Domain spec review + approval (this proposal)
  2. Provider registry + multi-route + strategy pattern (no behavior change, just restructure)
  3. Completion-aware worker (the core feature)
  4. Health check enhancement
  5. README/docs update + rename repo discussion

## Decisions

1. **Repo rename:** Done — `openclaw-jira-proxy` → `clawndom` (SC0RED/clawndom)
2. **Config format:** Strategy-based — support env vars as default, config file as option. Config loading itself uses a strategy so we can swap later.
3. **WS reconnection:** Reconnect-first, REST poll fallback, timeout as last resort. Never re-POST the event. See domain spec "Completion Tracking Resilience" requirement.
4. **Concurrency model:** Global concurrency gate is the primary throttle (protects the LLM API). Per-provider maxConcurrency is an optional fairness cap. This was corrected from the initial per-provider-only model which didn't match the actual resource being protected.
