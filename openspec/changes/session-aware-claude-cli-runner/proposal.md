## Why

The claude-cli runner spawns a fresh subprocess per inbound event. For Slack chat — which is interactive and conversational — this costs ~25s wall time per turn (mostly process spawn + IDENTITY/SOUL/template re-read) and discards all prior conversation context. Winston has no memory of his previous reply, the user has no continuity, and the latency makes interactive use feel robotic. This is the load-bearing UX gap blocking Winston Phase 2 from feeling like talking to a person.

## What Changes

- **NEW**: Session-aware claude-cli runner mode. When enabled for a route, Clawndom keeps the claude-cli subprocess warm between events for the same conversation, sending only the new user message via stdin instead of re-rendering the full template.
- **NEW**: `SessionPool` service that owns warm subprocess lifecycles in memory, keyed by a route-derived session key. Cold-start, idle reap, and reconnect all flow through this single ownership layer.
- **NEW**: Redis-backed session_id storage. The claude-cli session ID is captured from the first invocation's stream events and written to Redis with a configurable TTL. This survives subprocess death (idle reap, crash) and Clawndom restarts — the next event for the same key spawns with `claude --resume <id>` and conversation continuity is preserved.
- **NEW**: `SessionKeyStrategy` interface — provider-specific function `(payload, providerConfig) => string | null` that derives the session key. Slack strategy collapses DMs and assistant-threads to `event.channel` (one ongoing conversation per channel) and app_mentions in regular channels to `(channel, thread_ts ?? ts)` (one session per thread). Pattern matches existing `signatureStrategy` / `contextStrategy`.
- **NEW**: Per-key turn lock — serializes turns within a session so concurrent events for the same conversation don't race the subprocess's stdin.
- **NEW**: Idle reaper — kills subprocesses idle beyond a configurable timeout. Redis entry stays so the next event resumes cleanly.
- **NEW**: Optional `session` field on routing rules:
  ```yaml
  session:
    strategy: slack    # references a registered SessionKeyStrategy
    ttl: 7d            # Redis TTL for session_id
    idleTimeout: 30m   # warm-subprocess reaping window
  ```
  Rules without `session` get the existing per-event-spawn behavior unchanged. No breaking changes.
- **NEW**: Stale session_id fallback — if `claude --resume <id>` fails (JSONL cleaned up, session expired), the runner falls back to a fresh spawn and rewrites Redis with the new id.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-runner-strategy`: Adds session-aware runner mode, `SessionKeyStrategy` interface, `SessionPool` service, and the optional `session` field on routing rules. Per-event-spawn behavior remains the default; the new behavior is opt-in per route.

## Impact

- **Affected code**:
  - `src/runners/claude-cli.runner.ts` — gains a session-aware mode (long-lived subprocess, stdin-fed turns, session_id capture)
  - `src/services/agent-loader.service.ts` — routing rule schema gains optional `session` field
  - `src/services/session-pool.service.ts` — NEW, owns warm subprocess lifecycles + Redis state
  - `src/strategies/session-key/` — NEW directory, one strategy per provider that opts in (Slack first)
  - `src/services/worker.service.ts` — dispatches session-aware jobs through the pool instead of spawning per-event
  - `src/lib/logging` — new `session-pool` logger
- **Affected APIs**: None external. Internal `AgentRunner` interface gets a `runWithSession()` method alongside the existing `run()`.
- **Affected configuration**: Routing YAML schema gains optional `session` block per rule. No env-var changes.
- **Affected dependencies**: None. Redis is already a runtime dependency for BullMQ; reused for session_id storage. No new npm packages.
- **Out of scope** (called out for transparency, NOT delivered by this change):
  - Auto-summarization or context compaction when a long conversation exceeds the model's context window. Documented as a known limitation.
  - Auto-invalidation of sessions when the template file changes. Template fixes require manual Redis flush of the affected keys; documented as a known limitation.
  - Cross-agent session sharing.
  - Distributed Clawndom instances. Single-instance ownership of session_id within a key is assumed.
  - Schedule-driven routes (morning-briefing, evening-audit, daily-self-review) and per-event-stateless triage routes (gmail-heather, gmail-winston) explicitly do NOT opt in. Each scheduled run is a snapshot; conversational continuity is not desired.
