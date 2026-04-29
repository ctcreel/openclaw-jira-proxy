## Context

Today, every webhook event that routes to a `claude-cli` runner spawns a fresh subprocess: `claude --output-format stream-json` consumes a rendered template (currently 23k+ tokens for Slack chat — IDENTITY + SOUL + template + payload), runs to completion, and exits. Wall-time per Slack DM is ~25s; ~10s of that is process startup and prompt re-read, the rest is the agent thinking and executing tools. There is no continuity between events: each run is its own world, with no awareness of prior turns in the same conversation.

For scheduled runs (morning-briefing, evening-audit, daily-self-review), this is correct — each run is a self-contained snapshot. For Slack chat (Winston Phase 2 just shipped), it's the wrong shape: the user is having a conversation with Winston, and Winston is supposed to remember what he just said. He doesn't.

The Claude CLI already has the primitive needed to fix this: persistent on-disk session state (in `~/.claude/projects/<workspace-hash>/sessions/<id>.jsonl`) and a `--resume <id>` flag that picks up where a prior invocation left off. What's missing in Clawndom is the orchestration layer that knows when to keep a subprocess warm, when to reap it, and how to route follow-up events back to the right session.

This change introduces that orchestration layer. It's invisible to the existing scheduler/triage routes (which keep their stateless per-event-spawn behavior); it's opt-in via a new `session` block on routing rules.

## Goals / Non-Goals

**Goals:**

- Conversational continuity for Slack chat: Winston remembers his prior replies to the same user in the same channel/thread.
- Wall-time per chat turn under 15s on the warm path (i.e., when the subprocess for that conversation is still alive in memory). The cold path (idle reap, restart) pays a one-time ~10s spawn-and-resume cost.
- Crash-/restart-tolerance: AWS shutdowns aren't graceful. Session continuity must survive `SIGKILL` of the Clawndom process.
- Backward-compatible: existing per-event-spawn routes (every current production route except slack-winston) keep their current behavior with zero config changes.
- Provider-agnostic key derivation: the architecture works for Slack today, Jira-comment threads tomorrow, Gmail threads later. The provider-specific knowledge ("what counts as the same conversation") lives in a strategy implementation, not the core pool.

**Non-Goals:**

- **Auto-summarization or context compaction.** A long-running conversation eventually grows the session JSONL until each turn replays a 50k+ token prompt — and eventually exceeds the model's context window. Mitigation strategies (summarization, truncation, model-side windowing) are out of scope here. Documented as a known limitation.
- **Template-change auto-invalidation.** When the template file changes, in-flight sessions don't see the change — they continue from prior context, which references the old template. Operator clears the relevant Redis keys manually. Documented as a known limitation.
- **Cross-agent session sharing.** Two different agents (Winston and Scarlett, say) keep separate session pools and separate Redis namespaces.
- **Distributed Clawndom.** Assumes single-instance ownership of any given session key. If we ever scale horizontally, we'll need cross-instance locking — not in scope here.
- **Inbound rate limiting / fairness across sessions.** All sessions share the same priority. If 100 users hit Winston at once, they queue behind each other in BullMQ as they do today.

## Decisions

### Decision 1: Warm subprocess + Redis-backed session_id (combined "A + B" architecture)

The user pressure-tested two pure variants:

- **A: Session resume only.** Each event spawns a fresh `claude --resume <id>` process. Simple, restart-tolerant, but every turn pays the ~5-10s spawn cost.
- **B: Long-lived subprocess.** Keep the process warm in memory between turns. Fast, but loses continuity on subprocess death (idle reap, crash, restart).

**Chosen approach: both, layered.** The subprocess is kept warm in a `SessionPool` for fast-path turns. The session_id is captured on first spawn and persisted to Redis. When the subprocess dies (any reason — idle reap, OOM, restart), the next event for the same key looks up Redis, spawns `claude --resume <id>`, and the conversation continues. Redis is the recovery story; the warm subprocess is the speed story.

Rejected alternatives:
- **Pure A (resume-only).** Loses the speed win that motivates the whole change. The wall-time math (~18-20s vs. ~13-15s) doesn't justify the implementation cost on its own.
- **Pure B (warm-only).** Loses session continuity on every Clawndom restart and every idle reap, which feels broken. AWS instances do reboot occasionally; templates do change. Idle reaping is necessary to bound memory.

### Decision 2: Session key derivation lives in a `SessionKeyStrategy`, not a YAML expression

YAML config asks for a key expression. That works for the simplest provider (Slack assistant_thread: `event.thread_ts ?? event.ts`) but breaks down once you add DMs (one ongoing channel-scoped conversation, no thread_ts at all) and channel @mentions (separate threads = separate sessions). Real Slack semantics need conditional logic.

**Chosen approach: TypeScript strategy interface, registered by name.** Routing rule declares `session.strategy: 'slack'` and the runtime looks up the registered strategy. Pattern matches the existing `signatureStrategy` and `contextStrategy` strategies. Each strategy is a pure function `(payload, providerConfig) => string | null`; returning `null` means "this event should not use a session" (escape hatch for events the strategy doesn't recognize).

Rejected alternative: **template expression in YAML.** Considered `session.resumeKey: "{event.channel}:{event.thread_ts ?? event.ts}"`. Looks clean for the simple case, but requires either (a) a real expression language with conditionals (Slack DMs need to drop the thread_ts component) or (b) per-trigger-shape rule duplication, which would explode the routing config from one rule to four for slack-winston alone. Strategy code wins on clarity and testability.

### Decision 3: Per-key turn lock, in-memory only

Two events for the same key arriving in quick succession (e.g., a user sending two messages back-to-back before Winston has finished replying to the first) would race the subprocess's stdin. The second message's bytes could interleave with the first's response stream.

**Chosen approach: per-key in-memory mutex, acquired before writing to stdin and released on `result` event from claude-cli.** This is single-process state, owned by the SessionPool. A second event for the same key blocks until the first turn completes; BullMQ's existing job-level concurrency settings continue to bound concurrency across keys.

Rejected alternative: **Redis distributed lock.** Overkill for a single-instance Clawndom. Adds latency and a failure mode (lock holder dies, lock isn't released). Reserve for if/when we need cross-instance coordination.

### Decision 4: Session ID is captured from the first stream event, not a CLI flag

Claude CLI's `--output-format stream-json` emits an `init` event at the start of each invocation containing the `session_id`. The runner parses the stream anyway (existing code). Capturing the id is a one-line addition to the existing parser.

**Chosen approach: read session_id from the `init` event of the first invocation; persist it to Redis before the first user-facing tool call.** That keeps the persistence ahead of any user-visible side effect — if Clawndom dies after the agent has already typed in Slack, the session_id is in Redis and the next event resumes correctly.

Rejected alternative: **pre-generate a UUID and pass via `--session-id`.** Cleaner in theory (we'd know the id before the spawn), but Claude CLI's `--session-id` flag has historically been a moving target and not all versions support it for the resume case. Reading from the init event is the documented happy-path interface.

### Decision 5: Idle timeout governs warm-process lifetime, not session lifetime

Two timers are involved:
- **Subprocess idle timeout** (default 30 minutes): if a session has had no incoming events for this long, kill the warm subprocess to free memory. Redis entry is left intact.
- **Session TTL** (default 7 days): the Redis key for `session:<provider>:<key>` expires after this. Old conversations eventually fall out of recovery — the next event for that key starts fresh.

These are independent. A session can be reaped from memory (subprocess killed) and revived from Redis many times within its 7-day Redis TTL.

### Decision 6: Stale session_id falls back to fresh spawn, transparently

`claude --resume <bogus_id>` errors. The on-disk JSONL might have been cleaned up by an admin, or the session might have hit a Claude CLI bug. The runner detects the failure (init event reports an error, or process exits non-zero before the init event), drops the Redis key, and respawns fresh. The next event proceeds with a new session_id; conversation continuity is lost for that one transition, but the system stays operational.

This is the only place stale state has a recovery path; everywhere else, the absence of a Redis entry means "fresh" and the absence of an in-memory subprocess entry means "respawn from Redis."

### Decision 7: Routing rule schema gains an optional `session` block, not a top-level provider flag

Multiple rules under one provider could in principle want different session strategies (e.g., a future routing.slack with one rule for chat and another for slash-commands). Putting `session` on the rule keeps that flexibility.

```yaml
- name: chat
  condition: ...
  messageTemplate: templates/slack-chat.md
  session:
    strategy: slack
    ttl: 7d
    idleTimeout: 30m
```

A rule without `session` runs the existing per-event-spawn path. Provider-level config is unchanged.

## Risks / Trade-offs

- **[Risk]** Long-running conversations grow the session JSONL indefinitely; eventually each new turn replays a 50k+ token prompt and eventually exceeds the model's context window. **→ Mitigation**: documented as known limitation. Manual Redis flush starts a fresh session. Future change adds auto-compaction.
- **[Risk]** Anthropic prompt cache TTL is 5 minutes. Sporadic chat (a message every hour) loses the cache between turns and pays full price for replaying the conversation history. **→ Trade-off accepted**: still cheaper than spawning fresh + re-rendering the full template, and the latency win is real even when the cache is cold (skipping the spawn).
- **[Risk]** Template changes don't reach in-flight sessions. Operator updates `slack-chat.md` to fix a behavior bug; existing conversations continue with the old template baked into their session JSONL. **→ Mitigation**: documented as known limitation. Operator flushes affected Redis keys manually after a template change. Acceptable because template changes are rare and infrequent users are insulated from each other.
- **[Risk]** Subprocess crashes mid-turn leave the user without a reply (the inbound event was already acked by Slack). **→ Mitigation**: detect non-zero exit before result event, log to alerts, surface in observability. Retry-on-crash is not safe (Slack already acked, so a retry produces a duplicate reply if the original somehow succeeded). Same risk model as the existing per-event-spawn runner.
- **[Risk]** Memory leak: a stuck subprocess (hung claude-cli, infinite tool loop) holds memory until idle timeout. **→ Mitigation**: idle timeout fires regardless of subprocess state. A health-check ping (write a no-op event to stdin and expect a response within N seconds) could detect hangs sooner — out of scope for this change, file as follow-up if it becomes a real issue.
- **[Risk]** Redis becomes a single point of failure for session continuity. **→ Trade-off accepted**: Redis is already a hard dependency for BullMQ. If Redis is down, Clawndom isn't processing events anyway. AOF persistence is configured.
- **[Risk]** Session_id capture races subprocess startup. If we try to write to stdin before the init event arrives, we corrupt the session. **→ Mitigation**: SessionPool's `acquire()` blocks the caller until the init event has arrived. New sessions return only after the runner has confirmed the subprocess is ready. Tests cover this path explicitly.

## Migration Plan

This is purely additive — no existing behavior changes. Deployment steps:

1. Merge the change to `main`.
2. Build + deploy Clawndom (Winston's instance first, since that's where the use case is). Existing routes continue to behave exactly as they did before.
3. Add `session:` block to `routing.slack-winston.rules[0]` in winston-agency's `clawndom.yaml`. Push.
4. Restart Winston's clawndom-winston service to pick up the new routing rule.
5. DM Winston, verify: first turn ~25s (cold start, Redis miss, fresh spawn), subsequent turns within idle window <15s, Redis key present at `session:slack-winston:<channel>`, log line `session-pool: warm-reuse` on the second turn.

Rollback:
- Remove the `session:` block from the routing rule and restart. Routes revert to per-event-spawn behavior. No data loss; Redis keys age out via TTL.
- If the SessionPool itself is broken (subprocess won't spawn or hangs immediately), Clawndom stops accepting any session-aware events but continues serving non-session-aware routes normally.

## Open Questions

1. **Should the SessionPool emit lifecycle events on the SSE bus** (`session.spawned`, `session.reaped`, `session.resumed`) the way the slack-socket transport does? Probably yes — observability into warm-process lifetimes is valuable. Will decide during specs phase.
2. **Default values for ttl and idleTimeout**: 7d / 30m feel right but are calibrated against Winston's expected usage (low-volume, conversational). Reconsider once we have real usage data.
3. **Should sessions be reaped on Clawndom shutdown** (graceful close stdin → wait for clean exit), or just orphaned and re-resumed on next startup? Graceful close is nice but adds complexity. Probably orphan-and-resume is fine — Redis is the source of truth. Will decide in specs phase.
