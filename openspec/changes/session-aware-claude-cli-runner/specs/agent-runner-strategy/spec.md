## ADDED Requirements

### Requirement: Session-Aware Runner Mode (Opt-In Per Route)

The agent-runner subsystem SHALL support a session-aware mode for the `claude-cli` runner type, opt-in per routing rule via an optional `session` block. When a routing rule declares `session`, events matching that rule SHALL be dispatched to a long-lived `claude-cli` subprocess keyed by a route-derived session key, with conversation continuity preserved across events for the same key. When a routing rule does not declare `session`, events MUST be dispatched via the existing per-event-spawn behavior with no functional change.

#### Scenario: Session-aware route dispatches via SessionPool
- **GIVEN** A routing rule with `session: { strategy: 'slack', ttl: '7d', idleTimeout: '30m' }` and `messageTemplate: templates/slack-chat.md`
- **WHEN** A matching event arrives
- **THEN** The worker MUST acquire a session subprocess from the SessionPool (warm-reuse, Redis-resume, or fresh-spawn) instead of spawning a fresh per-event runner

#### Scenario: Non-session route preserves existing behavior
- **GIVEN** A routing rule with no `session` block
- **WHEN** A matching event arrives
- **THEN** The worker MUST spawn a fresh `claude-cli` subprocess per event using the existing runner path
- **AND** The SessionPool MUST NOT be consulted

#### Scenario: Schedule routes do not opt in
- **GIVEN** A scheduled rule (under `routing.schedule`)
- **WHEN** The cron triggers a run
- **THEN** The runner MUST spawn fresh per scheduled execution
- **AND** Schedule rules MUST NOT support a `session` block in their config schema

### Requirement: Routing Rule Schema Extension for Session

The agent-routing schema SHALL accept an optional `session` object on each rule under any provider (excluding `routing.schedule`). The schema SHALL validate the following fields:

- `strategy` (required string): the name of a registered `SessionKeyStrategy`
- `ttl` (required duration string, e.g., `7d`, `1h`): Redis TTL for the persisted session_id
- `idleTimeout` (required duration string, e.g., `30m`, `5m`): warm-subprocess reaping window

The schema MUST reject unknown strategy names at startup with a clear error identifying the misconfigured rule. Duration strings MUST parse to integer milliseconds; invalid duration strings MUST fail schema validation.

#### Scenario: Valid session block parses
- **GIVEN** A rule with `session: { strategy: 'slack', ttl: '7d', idleTimeout: '30m' }`
- **WHEN** Clawndom loads the agent config
- **THEN** The rule MUST be accepted with the session config attached

#### Scenario: Unknown strategy rejected at startup
- **GIVEN** A rule with `session: { strategy: 'bogus', ttl: '7d', idleTimeout: '30m' }`
- **WHEN** Clawndom loads the agent config
- **THEN** Startup MUST fail with an error naming the rule and the unknown strategy

#### Scenario: Invalid duration rejected at startup
- **GIVEN** A rule with `session: { strategy: 'slack', ttl: 'forever', idleTimeout: '30m' }`
- **WHEN** Clawndom loads the agent config
- **THEN** Startup MUST fail with a schema validation error identifying the invalid duration

#### Scenario: Schedule rule with session block rejected
- **GIVEN** A rule under `routing.schedule` with a `session` block
- **WHEN** Clawndom loads the agent config
- **THEN** Startup MUST fail with an error stating that schedule rules do not support `session`

### Requirement: Provider-Specific Session Key Strategy

The session subsystem SHALL define a `SessionKeyStrategy` interface providing a function `(payload, providerConfig) => string | null` that derives the session key for a given event. Strategies SHALL be registered by name (e.g., `slack`, `jira-thread`, `gmail-thread`) and looked up at runtime by the rule's `session.strategy` field. Returning `null` from a strategy MUST cause the worker to fall back to the per-event-spawn path for that single event (the strategy declined to handle it).

The Slack strategy MUST implement the following key derivation:

- For DMs (`event.channel_type === 'im'`): key is `event.channel` (one ongoing conversation per DM channel)
- For Slack Assistant threads (`event.assistant_thread` present, OR `event.channel_type === 'group'` with `event.thread_ts`): key is `event.channel` (one ongoing conversation per assistant panel)
- For app_mentions in regular channels (`event.type === 'app_mention'`, channel_type `'channel'`): key is `${event.channel}:${event.thread_ts ?? event.ts}` (separate thread = separate session)
- For thread replies in regular channels (`event.type === 'message'` with `event.thread_ts`, channel_type `'channel'`): key is `${event.channel}:${event.thread_ts}` (continue the existing thread's session)
- For any unrecognized shape: return `null`

#### Scenario: Slack DM derives channel-only key
- **GIVEN** A Slack event with `event.channel_type='im'`, `event.channel='D123'`, `event.ts='1.0'`
- **WHEN** The Slack SessionKeyStrategy resolves the key
- **THEN** The key MUST equal `D123`

#### Scenario: Slack assistant_thread derives channel-only key
- **GIVEN** A Slack event with `event.assistant_thread`, `event.channel='C456'`, `event.thread_ts='2.0'`
- **WHEN** The Slack SessionKeyStrategy resolves the key
- **THEN** The key MUST equal `C456`

#### Scenario: Slack channel mention derives channel+thread key
- **GIVEN** A Slack event with `event.type='app_mention'`, `event.channel_type='channel'`, `event.channel='C789'`, `event.ts='3.0'`, no `thread_ts`
- **WHEN** The Slack SessionKeyStrategy resolves the key
- **THEN** The key MUST equal `C789:3.0`

#### Scenario: Slack channel thread reply continues the same key
- **GIVEN** A Slack event with `event.type='message'`, `event.channel_type='channel'`, `event.channel='C789'`, `event.thread_ts='3.0'`, `event.ts='4.0'`
- **WHEN** The Slack SessionKeyStrategy resolves the key
- **THEN** The key MUST equal `C789:3.0` (matching the parent app_mention's key)

#### Scenario: Unrecognized event returns null
- **GIVEN** A Slack event with `event.type='reaction_added'`
- **WHEN** The Slack SessionKeyStrategy resolves the key
- **THEN** The key MUST equal `null` and the worker MUST fall back to the per-event-spawn path

### Requirement: SessionPool Owns Subprocess Lifecycle

The session subsystem SHALL provide a `SessionPool` service responsible for the lifecycle of warm `claude-cli` subprocesses. The pool MUST maintain an in-memory map from session key to live subprocess. The pool MUST expose an `acquire(key, providerConfig, sessionConfig)` method that returns a turn handle; callers MUST use this handle to send a user message and receive the resulting stream events.

The pool MUST persist session_id to Redis under key `session:<provider>:<key>` as soon as the id is captured from the `init` event of the first subprocess invocation, with TTL set from the rule's `session.ttl`.

The pool MUST resolve `acquire` requests in the following priority order:

1. If an in-memory subprocess exists for the key and is healthy: reuse it (warm path).
2. Else if Redis has a session_id for the key: spawn `claude --resume <id> --output-format stream-json` and add to the in-memory map.
3. Else: spawn `claude --output-format stream-json` (fresh), capture session_id from the first stream `init` event, persist to Redis, and add to the in-memory map.

#### Scenario: Warm path reuses existing subprocess
- **GIVEN** A SessionPool with an active subprocess for key `D123`
- **WHEN** `acquire('D123', ...)` is called
- **THEN** The pool MUST return a turn handle wrapping the existing subprocess
- **AND** No new subprocess MUST be spawned

#### Scenario: Cold path resumes from Redis when subprocess absent
- **GIVEN** A SessionPool with no in-memory subprocess for key `D123`, and Redis has `session:slack-winston:D123 -> abc123`
- **WHEN** `acquire('D123', ...)` is called
- **THEN** The pool MUST spawn `claude --resume abc123 --output-format stream-json`
- **AND** The new subprocess MUST be added to the in-memory map under key `D123`

#### Scenario: Fresh path spawns and persists when neither exists
- **GIVEN** A SessionPool with no in-memory subprocess and no Redis entry for key `D123`
- **WHEN** `acquire('D123', ...)` is called
- **THEN** The pool MUST spawn `claude --output-format stream-json` without a `--resume` flag
- **AND** Upon receiving the `init` stream event, the pool MUST extract `session_id` and write it to Redis under `session:<provider>:D123` with TTL from `session.ttl`
- **AND** The subprocess MUST be added to the in-memory map under key `D123`

### Requirement: Per-Key Turn Lock

The SessionPool SHALL serialize turns within a single session key. While one event for a key is being processed (from stdin write through `result` stream event), a second event for the same key MUST block until the first completes. The lock MUST be per-key, not global — events for different keys MUST proceed concurrently subject to BullMQ's existing concurrency settings.

#### Scenario: Concurrent events for same key serialize
- **GIVEN** Two events arrive for key `D123` within 100ms of each other
- **WHEN** The first event acquires the turn lock and writes to stdin
- **AND** The second event calls `acquire('D123', ...)`
- **THEN** The second event MUST block until the first emits its `result` stream event and releases the lock
- **AND** The two turns' stdout streams MUST NOT interleave

#### Scenario: Concurrent events for different keys do not block
- **GIVEN** Two events arrive within 100ms — one for key `D123`, one for key `D456`
- **WHEN** Both events call `acquire(...)` for their respective keys
- **THEN** Both turns MUST proceed concurrently without blocking each other

### Requirement: Idle Subprocess Reaping

The SessionPool SHALL maintain an idle timer per active subprocess. When no new event has been processed by a subprocess for `idleTimeout` milliseconds (from rule config), the pool MUST gracefully terminate the subprocess (close stdin, wait for clean exit) and remove it from the in-memory map. The Redis entry for the session_id MUST NOT be deleted; the next event for that key resumes from Redis as the cold path.

#### Scenario: Idle subprocess reaped after timeout
- **GIVEN** A SessionPool with an active subprocess for key `D123` and `idleTimeout: 30m`
- **WHEN** No event arrives for `D123` within 30 minutes of the last completed turn
- **THEN** The pool MUST close the subprocess's stdin and remove the entry from the in-memory map
- **AND** Redis key `session:<provider>:D123` MUST remain present

#### Scenario: Reaped session resumes on next event
- **GIVEN** A SessionPool whose subprocess for key `D123` was idle-reaped 1 hour ago, with Redis entry `session:slack-winston:D123 -> abc123` still present
- **WHEN** A new event arrives for `D123`
- **THEN** The pool MUST spawn `claude --resume abc123 --output-format stream-json` (cold path)
- **AND** The user MUST observe conversational continuity

### Requirement: Session ID Capture and Redis Persistence

The session-aware runner MUST parse the stream-json output of `claude-cli` and extract `session_id` from the first `init` event of any fresh (non-resume) invocation. The runner MUST persist this id to Redis under `session:<provider>:<session_key>` with the TTL configured on the rule, before any subsequent user-visible side effect of the run (i.e., before any tool call that posts to a user-facing channel). On resume invocations, the runner MUST verify the `init` event's `session_id` matches the resume id; a mismatch indicates a Claude CLI failure mode and MUST be logged and treated as a stale-session fallback (see Stale Session Recovery requirement).

#### Scenario: Fresh session captures and persists id
- **GIVEN** A fresh subprocess spawned with no `--resume` flag
- **WHEN** The first stream event is `{ type: 'init', session_id: 'abc123', ... }`
- **THEN** The runner MUST write `session:<provider>:<key> -> abc123` to Redis with the configured TTL
- **AND** The persistence MUST complete before any user-facing tool call is permitted

#### Scenario: Resume with matching id proceeds normally
- **GIVEN** A subprocess spawned with `--resume abc123`
- **WHEN** The first stream event is `{ type: 'init', session_id: 'abc123', ... }`
- **THEN** The runner MUST proceed without rewriting Redis

#### Scenario: Resume with mismatched id triggers stale fallback
- **GIVEN** A subprocess spawned with `--resume abc123`
- **WHEN** The first stream event is `{ type: 'init', session_id: 'def456', ... }` (mismatch)
- **THEN** The runner MUST log a stale-session warning
- **AND** Treat the result as a fresh session: persist `def456` to Redis, displacing the prior id

### Requirement: Stale Session Recovery

When `claude --resume <id>` fails to start (non-zero exit, no `init` event within a startup grace period of 15 seconds, or any error event prior to `init`), the SessionPool MUST treat the session_id as stale: delete the Redis key for that session, spawn a fresh subprocess (no `--resume`), capture the new session_id, persist it to Redis, and proceed with the new session. The user-facing event MUST then be processed against the fresh session. Conversation continuity is lost for that one transition, but the system MUST stay operational.

#### Scenario: Resume of expired session falls back to fresh
- **GIVEN** Redis has `session:slack-winston:D123 -> stale_id`, but the on-disk session JSONL has been deleted
- **WHEN** `acquire('D123', ...)` triggers `claude --resume stale_id --output-format stream-json`
- **AND** The subprocess exits with a non-zero code before emitting an `init` event
- **THEN** The pool MUST delete `session:slack-winston:D123` from Redis
- **AND** Spawn a fresh `claude --output-format stream-json` subprocess
- **AND** Capture the new session_id, persist it, and proceed with the user's event

### Requirement: Session-Aware Runner Mode for claude-cli Runner

The `claude-cli` runner SHALL expose a session-aware invocation method (`runWithSession()` or equivalent) that accepts a turn handle from the SessionPool plus a per-event payload (template-rendered or raw). When invoked in session-aware mode, the runner MUST send only the new event payload to the subprocess's stdin (not the full template), parse the resulting stream events through the existing parser, and return upon receiving the `result` event. The existing `run()` method (per-event-spawn) MUST continue to function unchanged for non-session routes.

#### Scenario: Session-aware turn sends only new event to stdin
- **GIVEN** A turn handle for key `D123` and a rendered new event payload
- **WHEN** The runner is invoked via `runWithSession`
- **THEN** Only the new event payload MUST be written to the subprocess's stdin
- **AND** The full template MUST NOT be re-rendered or re-sent
- **AND** The runner MUST return when the subprocess emits a `result` stream event for this turn

#### Scenario: Per-event runner unchanged
- **GIVEN** A non-session route
- **WHEN** The worker invokes `run()` (existing API)
- **THEN** A fresh subprocess MUST be spawned with the rendered template as stdin
- **AND** The runner MUST behave identically to its pre-change behavior

### Requirement: Observability for Session Lifecycle Events

The SessionPool SHALL emit lifecycle events to the existing SSE event bus matching the convention used by `slack-socket-transport`:

- `session.spawned` (provider, key, session_id, mode: `'fresh'` or `'resume'`)
- `session.reaped` (provider, key, idle_for_ms)
- `session.resumed` (provider, key, session_id) — emitted when a cold-path resume succeeds
- `session.stale` (provider, key, prior_session_id, reason) — emitted on stale-session fallback
- `session.error` (provider, key, error_message) — emitted on subprocess crashes mid-turn

Each event MUST include `timestamp` (epoch milliseconds) and `traceId` (the provider name, matching slack-socket-transport convention). All session events MUST also be logged at info level (errors at error level).

#### Scenario: Fresh spawn emits session.spawned
- **GIVEN** A SessionPool spawning a fresh subprocess for key `D123`
- **WHEN** The init event is received and Redis is updated
- **THEN** A `session.spawned` event MUST be published with `mode: 'fresh'`, `provider`, `key`, and the captured `session_id`

#### Scenario: Idle reap emits session.reaped
- **GIVEN** A SessionPool reaping an idle subprocess for key `D123` after 35 minutes
- **WHEN** The subprocess exits cleanly
- **THEN** A `session.reaped` event MUST be published with `provider`, `key`, and `idle_for_ms` ≈ `2100000`

#### Scenario: Cold-path resume emits session.resumed
- **GIVEN** A SessionPool resolving `acquire('D123')` via Redis lookup
- **WHEN** The resumed subprocess emits its first `init` event matching the expected session_id
- **THEN** A `session.resumed` event MUST be published with `provider`, `key`, and `session_id`

### Requirement: Known Limitations Documented

This change SHALL document the following known limitations in the change's design.md and the agent-runner-strategy spec, so operators understand the failure modes:

- **Long conversations grow without bound.** A session that accumulates 50+ turns will eventually exceed the model's context window. No auto-compaction is provided. Mitigation: operator manually invalidates the Redis key (`DEL session:<provider>:<key>`); next event starts a fresh session.
- **Template changes do not invalidate in-flight sessions.** When `messageTemplate` content changes on disk, existing sessions continue from prior context (which has the old template's instructions baked in). Mitigation: operator runs `KEYS session:<provider>:*` and deletes affected keys after a template fix that needs to reach in-flight conversations.
- **Single-instance assumption.** The SessionPool's in-memory state and turn-lock semantics assume one Clawndom process owns any given session key at a time. Multi-instance deployments would require cross-instance coordination, which this change does not address.

#### Scenario: Spec documents the long-conversation limit
- **GIVEN** This requirement
- **WHEN** Operators read the agent-runner-strategy spec
- **THEN** They MUST find an explicit statement of the long-conversation context-window risk and the manual-invalidation mitigation

#### Scenario: Spec documents the template-drift behavior
- **GIVEN** This requirement
- **WHEN** Operators read the agent-runner-strategy spec
- **THEN** They MUST find an explicit statement that template changes do not propagate to existing sessions and that manual Redis-key invalidation is required for fixes that must reach in-flight conversations
