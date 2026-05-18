## Purpose

Defines the per-actor interaction log: a Redis sorted set of recent
chat-style turns keyed on entity ID, written on every chat-style run
and read on demand by routes that opt in. The log gives Winston
cross-surface continuity ("you asked yesterday in email, then said
'cancel that' in Slack today") without coupling memory semantics to
surface boundaries.

## Requirements

### Requirement: Sorted Set Per Actor

The log MUST be a Redis sorted set keyed by
`interactions:<agent_id>:<actor_id>` for resolved actors, or
`interactions:<agent_id>:stranger:<email>` for stranger actors.
Score MUST be `timestamp_ms`. Each member MUST be the JSON
serialization of an `InteractionEntry`.

#### Scenario: Resolved Actor Key

- **GIVEN** Agent `winston` and actor `t_heather`
- **WHEN** An interaction is recorded
- **THEN** The Redis key MUST be `interactions:winston:t_heather`

#### Scenario: Stranger Key

- **GIVEN** Agent `winston` and stranger email `bob@example.com`
- **WHEN** An interaction is recorded
- **THEN** The Redis key MUST be
  `interactions:winston:stranger:bob@example.com`

### Requirement: InteractionEntry Shape

Each entry MUST have:

- `id`: ULID
- `actor_id`: entity ID, or `null` for strangers
- `actor_email`: present when `actor_id` is null
- `surface`: e.g., `slack`, `email`, `mcp`
- `route`: `<provider>.<rule>` string
- `inbound_text`: the user's prompt text
- `outbound_summary`: the agent's final assistant text, truncated to
  500 characters with `...` suffix when truncated
- `timestamp`: epoch milliseconds
- `trace_id`: the run's trace ID

#### Scenario: Truncation Marker

- **GIVEN** An outbound assistant text of 800 characters
- **WHEN** Recorded
- **THEN** `outbound_summary` MUST be exactly 503 characters long
  (500 + `...`)

### Requirement: Unconditional Write on Chat Routes

The writer MUST write one entry per completed agent run on any rule
that has `interactions:` opt-in (writes happen on opt-in only — the
log is not a global side-effect). Writes MUST happen at end-of-run,
after audit emission. Write failures MUST be logged but MUST NOT
fail the job.

#### Scenario: Slack Chat Records Entry

- **GIVEN** A `slack-winston.chat` rule with `interactions: { topN:
  5 }`
- **WHEN** A run completes from `t_heather`
- **THEN** Exactly one entry MUST appear in
  `interactions:winston:t_heather`
- **AND** The audit log MUST also contain the run record

#### Scenario: Redis Write Failure

- **GIVEN** Redis is temporarily unreachable
- **WHEN** A run completes
- **THEN** The writer MUST log the failure
- **AND** The job MUST still complete successfully

### Requirement: Bounded Length and Retention

Each per-actor sorted set MUST be trimmed to `maxLogLength` entries
(default 200, configurable via the agent's top-level `interactions:`
block). Trim MUST happen on every write via ZADD + ZREMRANGEBYRANK.

A separate daily prune MUST delete entries older than `retainDays`
(default 180 days). Prune MUST scan all interaction-log keys for the
agent and MUST NOT require iteration through every individual
entry.

#### Scenario: Trim After 200 Entries

- **GIVEN** An actor with 200 existing entries
- **WHEN** Entry 201 is written
- **THEN** The oldest entry MUST be removed
- **AND** The set's cardinality MUST remain 200

#### Scenario: Old Entries Pruned

- **GIVEN** An entry older than `retainDays` days
- **WHEN** The daily prune runs
- **THEN** That entry MUST be deleted
- **AND** Entries within retention MUST remain

### Requirement: Per-Route Retrieval

Retrieval is OPT-IN per rule via `interactions: { topN: N }`. When
opted in, the worker MUST call `InteractionLog.recent(actor_id,
topN)` before render and pass the result as `interactions` in the
template context. Rules without `interactions:` MUST NOT incur the
read cost and MUST NOT have `{{ interactions }}` populated.

#### Scenario: Opted-In Rule Receives Interactions

- **GIVEN** A rule with `interactions: { topN: 5 }`
- **AND** The actor has 12 historical entries
- **WHEN** A new event matches the rule
- **THEN** The template context's `interactions` MUST contain the 5
  most-recent entries in reverse chronological order

#### Scenario: Opt-Out Rule

- **GIVEN** A rule with no `interactions:` field
- **WHEN** A new event matches the rule
- **THEN** The template context MUST NOT contain `interactions` (or
  it MUST be an explicit empty/sentinel value)

### Requirement: Stranger Continuity

Routes that opt in MUST receive the stranger key's history when the
resolved actor is a stranger. The template-visible shape MUST be
identical to the resolved-actor case (`interactions` array of
entries); only the key under the hood differs.

#### Scenario: Repeat Stranger

- **GIVEN** `bob@example.com` has previously emailed Winston three
  times
- **WHEN** A new email from `bob@example.com` matches a rule with
  `interactions: { topN: 5 }`
- **THEN** The template context's `interactions` MUST contain those
  three prior entries

### Requirement: No Cross-Identity Migration on Promotion

When a stranger is later promoted to a known entity (via
`entity.upsert` creating a contact or team_member with the matching
email), the stranger-keyed entries MUST remain at the stranger key.
They MUST NOT be auto-migrated to the new entity's key.

#### Scenario: Stranger Promoted Mid-Conversation

- **GIVEN** `bob@example.com` has 3 entries at the stranger key
- **WHEN** An operator creates contact `p_bob` via `entity.upsert`
- **THEN** The 3 stranger entries MUST still be at the stranger key
- **AND** Subsequent runs MUST write to `interactions:winston:p_bob`
- **AND** No backfill MUST be performed automatically
