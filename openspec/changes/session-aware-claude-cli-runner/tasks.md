## 1. Schema and configuration

- [ ] 1.1 Add `sessionConfigSchema` to `src/config.ts` (or wherever `agentRoutingSchema` lives). Optional `session` block with `strategy: z.string()`, `ttl: durationStringSchema`, `idleTimeout: durationStringSchema`. Reuse / introduce a duration parser that turns `"7d"`/`"30m"`/`"1h"` into integer milliseconds and rejects malformed values at parse time.
- [ ] 1.2 Extend `agentRuleSchema` in `src/services/agent-loader.service.ts` to accept the optional `session` block on per-provider rules (NOT on `routing.schedule` rules — schedule rules MUST reject `session` at parse time with a clear error).
- [ ] 1.3 At config-load time, validate `session.strategy` against the registered strategy names; fail startup with a clear error naming the rule and the unknown strategy.
- [ ] 1.4 Add unit tests for schema acceptance, schedule-rejection, unknown-strategy rejection, and invalid-duration rejection.

## 2. SessionKeyStrategy interface and Slack strategy

- [ ] 2.1 Create `src/strategies/session-key/types.ts` defining the `SessionKeyStrategy` interface: `name: string` and `extract(payload: unknown, providerConfig: ProviderConfig): string | null`.
- [ ] 2.2 Create `src/strategies/session-key/slack.ts` implementing the Slack strategy per the spec's key-derivation rules (DM → channel, assistant_thread → channel, app_mention/channel-thread → `${channel}:${thread_ts ?? ts}`, others → null).
- [ ] 2.3 Create `src/strategies/session-key/index.ts` exporting a `getSessionKeyStrategy(name: string)` resolver and a registry. Slack is the only registered strategy initially; the registry MUST be extensible without changing core code.
- [ ] 2.4 Unit tests for the Slack strategy covering DMs, assistant_thread starters, assistant_thread continuations (no `assistant_thread` field but `thread_ts` present), app_mentions, channel thread replies, and unrecognized event shapes (return null).

## 3. SessionPool service

- [ ] 3.1 Create `src/services/session-pool.service.ts` with the public surface:
  ```ts
  acquire(key: string, providerConfig: ProviderConfig, sessionConfig: SessionConfig): Promise<TurnHandle>
  shutdown(): Promise<void>
  ```
  Internal state: `Map<string, ActiveSession>` where `ActiveSession` holds the `ChildProcess`, the per-key turn lock (a Promise chain or AsyncLock), the idle-timer reference, and the captured `session_id`.
- [ ] 3.2 Implement `acquire()` priority order: warm-reuse → Redis-resume → fresh-spawn. Use the project's existing Redis client (BullMQ shares one). Key format: `session:<provider>:<session_key>`. Persist `session_id` on first `init` event of a fresh spawn with the configured TTL via `SET ... EX <seconds>`.
- [ ] 3.3 Implement per-key turn lock semantics. While a turn is in flight (between stdin write and `result` stream event), subsequent `acquire()` calls for the same key MUST block. Concurrent `acquire()` calls for different keys MUST proceed without contention.
- [ ] 3.4 Implement idle reaping: each successful turn resets the idle timer for that key; on timer expiry, gracefully close stdin, wait up to N seconds for clean exit, then SIGTERM if needed. Remove the entry from the in-memory map. Redis key MUST remain present.
- [ ] 3.5 Implement stale-session fallback: if `claude --resume <id>` exits non-zero before the `init` event, or no `init` event arrives within a 15s startup grace period, delete the Redis key and respawn fresh. Capture and persist the new `session_id`.
- [ ] 3.6 Implement `shutdown()`: gracefully close stdin on all active subprocesses, wait up to N seconds, then exit. Idempotent.
- [ ] 3.7 Wire the SessionPool into the server bootstrap (`src/server.ts` or wherever singletons are initialized). Lazy-init on first session-aware route or eager-init at startup — pick one and document.
- [ ] 3.8 Unit tests covering: warm-reuse hit, cold-path resume (Redis hit), fresh-spawn (Redis miss), stale-fallback (resume fails), per-key turn-lock serialization, cross-key concurrency, idle reap, shutdown cleanup.

## 4. Stream-event parser extension

- [ ] 4.1 Extend the existing claude-cli stream parser (`src/runners/claude-cli.runner.ts` or wherever stream-json events are consumed) to recognize and surface the `init` event's `session_id`. The parser MUST emit a callback or return a value that the SessionPool can read. Keep this internal — the existing per-event-spawn path doesn't need to know about it.
- [ ] 4.2 Verify the parser emits a clear `result` event signal that the SessionPool can use to release the turn lock. Check existing implementation; add the signal if it's not already there.
- [ ] 4.3 Unit tests confirming the parser surfaces `session_id` from real `init` events and doesn't break on streams that don't include one (paranoia for protocol drift).

## 5. claude-cli runner: session-aware mode

- [ ] 5.1 Add a `runWithSession()` method to the `claude-cli` runner. Signature accepts: a `TurnHandle` from the SessionPool, the rendered new event payload (string, NOT the full template), and the same observability hooks as the existing `run()` (logger, prompt-hash, etc.).
- [ ] 5.2 `runWithSession()` writes the new event payload to the subprocess's stdin, waits for the `result` stream event, returns the result. It MUST NOT spawn a subprocess (the pool owns spawning) and MUST NOT close stdin (the pool owns idle reaping).
- [ ] 5.3 Preserve all existing observability — prompt-hash logging, full-prompt at debug, runId association — for session-aware turns. Each turn gets its own runId.
- [ ] 5.4 `run()` (existing per-event-spawn API) MUST remain unchanged. No regressions in its tests.
- [ ] 5.5 Unit tests for `runWithSession`: happy-path turn, mid-turn subprocess crash (must surface as runner error), result-event parsing.

## 6. Worker dispatch

- [ ] 6.1 In `src/services/worker.service.ts`, when processing a job whose matched routing rule has `session`: derive the session key via the configured strategy. If the strategy returns null, fall back to per-event-spawn (existing path). Otherwise, acquire a turn handle from the SessionPool and call `runWithSession()`.
- [ ] 6.2 If the rule has no `session` block: dispatch via the existing `run()` path with no behavioral change.
- [ ] 6.3 Render the per-turn payload with the existing template-rendering pipeline. For the FIRST turn of a session (fresh-spawn case), the rendered template includes IDENTITY/SOUL/template/payload as today. For subsequent turns (warm-reuse or cold-resume), render only the new event's payload section — IDENTITY/SOUL/template are already in the session JSONL. Implement this branching in the worker; the renderer can take a `mode: 'full' | 'event-only'` flag.
- [ ] 6.4 Logging: every session-aware dispatch MUST log `session_key`, `session_path` ("warm" | "cold-resume" | "fresh"), `provider`, and `runId` at info level.
- [ ] 6.5 Unit tests for worker dispatch covering: session rule + null-key fallback, session rule + warm-path dispatch, session rule + cold-path dispatch, session rule + fresh-spawn dispatch, non-session rule unchanged dispatch.

## 7. Observability

- [ ] 7.1 Define the new event types in the SSE event bus type union: `session.spawned`, `session.reaped`, `session.resumed`, `session.stale`, `session.error`. All MUST include `timestamp` (epoch ms) and `traceId` (provider name).
- [ ] 7.2 Emit `session.spawned` from SessionPool on every fresh or resume spawn with the right `mode`.
- [ ] 7.3 Emit `session.reaped` on idle-reap with `idle_for_ms`.
- [ ] 7.4 Emit `session.resumed` when a cold-path resume completes successfully.
- [ ] 7.5 Emit `session.stale` on stale-session fallback with `prior_session_id` and `reason`.
- [ ] 7.6 Emit `session.error` on subprocess crashes mid-turn.
- [ ] 7.7 Add an info-level log line for each emitted event (errors at error level), matching slack-socket-transport convention.

## 8. Routing rule update for Winston (slack-winston)

- [ ] 8.1 In winston-agency repo, update `workspaces/winston/clawndom.yaml`: add `session` block to `routing.slack-winston.rules[0].chat`:
  ```yaml
  session:
    strategy: slack
    ttl: 7d
    idleTimeout: 30m
  ```
- [ ] 8.2 Document the change in winston-agency's commit message; reference this OpenSpec change.

## 9. Validation, testing, and rollout

- [ ] 9.1 Run `make check-all` locally; ensure lint, type-check, prettier, and the existing test suite pass with the new code in place.
- [ ] 9.2 Add integration test scaffolding (vitest with a mocked `claude` binary) that exercises the full warm/cold/fresh paths end-to-end against the SessionPool. The mock binary takes `--resume`, emits a configurable `init` event, accepts stdin lines as turns, emits `result` events.
- [ ] 9.3 Verify coverage gates stay green (87/88/93/87 line/branch/function/statement).
- [ ] 9.4 Manual smoke test on Winston's EC2:
  1. Deploy Clawndom build with this change.
  2. Update Winston's `clawndom.env` agent ref to pull latest winston-agency main.
  3. Restart `clawndom-winston`, watch for clean startup with `Slack socket connected`.
  4. DM Winston in his Assistant panel; verify `session.spawned` event with `mode: 'fresh'`, Redis key created.
  5. Send a follow-up message; verify warm-reuse log line, response time < 15s.
  6. Wait > 30 minutes (or temporarily lower idleTimeout to 60s for the test); verify `session.reaped`.
  7. Send another message; verify cold-path resume (`session.resumed`), Winston remembers prior context.
  8. Restart `clawndom-winston`; verify the next message resumes cleanly from Redis.
- [ ] 9.5 Update `winston-slack-socket-mode.md` memory file (or the equivalent operational doc) to reflect that Winston's slack-winston route is now session-aware, including the manual Redis flush procedure for template changes.
- [ ] 9.6 Document operator runbook for the known limitations: how to flush a single session (`redis-cli DEL session:slack-winston:<key>`), how to flush all (`redis-cli --scan --pattern 'session:slack-winston:*' | xargs redis-cli DEL`), and when to reach for each.
