## Scope

This task list is **Clawndom-side only** — the substrate. The workspace-
side artifacts (kind schemas, `relations.json`, per-route `entities.kinds`
declarations, the migration script) land in their own repo's PR (e.g.,
`winston-agency`). The boundary is documented in `proposal.md` under
"Substrate vs. Workspace."

## 1. SQLite store and core service

- [ ] 1.1 `src/services/entities/entity-store.service.ts` — `EntityStore`
  class wrapping a single `better-sqlite3` connection. Methods:
  `find(query)`, `get(id, expandRelations?)`, `upsert(kind, properties,
  options)`, `relate(fromId, type, toId, properties?)`,
  `unrelate(fromId, type, toId)`, `purge(id, reason, actor)`. All
  writes go through the audit-log writer (1.5).
- [ ] 1.2 Schema migration runner: on startup, ensure the three tables
  (`entities`, `relations`, `entity_audit`) exist with the indexes
  described in the design. Idempotent: re-running on an existing DB
  is a no-op. WAL mode enabled.
- [ ] 1.3 ID generator: `t_<slug>` and `l_<slug>` are passed in by
  the caller (migration script + agent); `c_<uuid-v4>` and
  `p_<uuid-v4>` are generated when an upsert has no provided ID and
  no natural-key match found.
- [ ] 1.4 Natural-key dedup in `upsert`: when caller does not supply
  `id`, the service computes the kind-specific natural key
  (`team_member`: lowercase email; `client`: legal_name + dob;
  `contact`: lowercase email, then (name, phone) fallback;
  `location`: slug) and looks up an existing entity. If found,
  updates; if not, creates with a fresh ID.
- [ ] 1.5 Audit-log writer: every successful create / update / relate
  / unrelate / purge inserts one row into `entity_audit` with the
  before/after diff. Trace ID + actor (`'tool:entity.upsert'`,
  `'handler:intake'`, `'migration'`) passed in by the caller.
  Failure to write the audit row rolls back the primary write.
- [ ] 1.6 Last-writer-wins on `upsert`: when an existing entity is
  found, the new `properties` object replaces the existing one in
  full. `created_at` is preserved; `updated_at` is set.
- [ ] 1.7 `purge` cascade: deletes the entity row, deletes outgoing
  `relations` rows, leaves incoming `relations` rows in place and
  records the list of orphaned incoming relations in the audit-log
  diff.
- [ ] 1.8 Tests: round-trip create, idempotent re-upsert on natural
  key, status-based filtering in `find`, relation expand on `get`,
  audit-log records exact diff, purge cascade behavior,
  concurrent-upsert safety under WAL.

## 2. Schema loader and validator

- [ ] 2.1 `src/services/entities/entity-schema.service.ts` — loads
  JSON Schema files from the agent's workspace path at boot
  (e.g., `<workspace>/schemas/*.schema.json`). Caches the compiled
  schemas in memory.
- [ ] 2.2 Validates `properties` against the kind's schema on every
  `upsert`. Schemaless fallback when no schema file exists for a
  kind. Errors name the failing property and the constraint that
  failed.
- [ ] 2.3 Date format: properties declared with `"format": "date"`
  MUST be ISO-8601 (`YYYY-MM-DD`). Validator enforces.
- [ ] 2.4 Email format: properties declared with `"format": "email"`
  MUST pass standard email validation.
- [ ] 2.5 Schema reload: workspace deploy may swap schema files;
  the loader reads files on each `EntityStore` construction. (For
  agents that restart on workspace reload, this is implicit; for
  long-running agents that hot-reload, an explicit reload hook may
  land later.)
- [ ] 2.6 `relations.json` loader: reads the workspace's
  `relations.json` (e.g., `<workspace>/relations.json`) at boot.
  Used by `entity.relate` to validate relation types and property
  shapes against the declared schema, and by the `{{ entity_model
  }}` renderer.
- [ ] 2.7 Tests: a known-good record validates; a known-bad record
  is rejected with a clear error; schemaless fallback accepts an
  arbitrary object; ISO-8601 enforcement; unknown relation type
  rejected.

## 3. Internal identity resolver

- [ ] 3.1 `src/types/actor.ts` — discriminated `Actor` union with
  the kinds defined by the workspace's schemas (Clawndom doesn't
  hardcode kind names; the runtime carries them through).
- [ ] 3.2 `src/services/entities/entity-resolver.service.ts` —
  `EntityResolver` class with `resolve(hints: IdentityHints):
  Promise<Actor>`. Auto-discovers which kinds participate by
  scanning loaded schemas for `"format": "email"` properties and
  `slack_user_id` properties.
- [ ] 3.3 Chain order: slack_user_id → email/oidc_email → stranger.
  First match wins.
- [ ] 3.4 Resolver result attached to event context as `actor`.
  Existing route-condition primitives already handle arbitrary
  field paths; documented as supported on `actor.*`.
- [ ] 3.5 Tests: each chain step, conflicting hints, missing
  matching entity, stranger fallback, kind discovery through
  schemas (a new email-typed kind is automatically scanned).

## 4. Surface-adapter identity hints

- [ ] 4.1 `src/strategies/transport/slack-socket.transport.ts` —
  include `identityHints: { slack_user_id: event.user }` on the
  event context.
- [ ] 4.2 `gmail-pubsub` webhook ingest — `identityHints: { email:
  <emailAddress from the Pub/Sub claim> }`.
- [ ] 4.3 `/api/tasks` internal dispatch — `identityHints: { email:
  context.dispatching_actor_email }` when available.
- [ ] 4.4 Tests: each adapter lands the right hints on the event
  context.

## 5. HTTP endpoints

- [ ] 5.1 `src/controllers/entities.controller.ts` — six handlers:
  - `GET /api/agents/:agent/entities` (list + search)
  - `GET /api/agents/:agent/entities/:id` (fetch, optional
    `?expand=relations`)
  - `POST /api/agents/:agent/entities` (upsert)
  - `POST /api/agents/:agent/entities/:id/relations` (relate)
  - `DELETE /api/agents/:agent/entities/:id/relations/:type/:to`
    (unrelate)
  - `GET /api/agents/:agent/entities/audit?since=...` (audit log
    tail)
- [ ] 5.2 `src/routes/entities.routes.ts` — route mounting under the
  per-agent scope. Bearer-token gated.
- [ ] 5.3 Zod request validation in the controller. Errors return
  400 with the same RFC 7807-style shape as existing controllers.
- [ ] 5.4 Tests: each endpoint round-trips, auth failure, bad
  payload, expand-relations populates correctly, audit endpoint
  filters by `since`.

## 6. Per-route `entities.kinds` enforcement

- [ ] 6.1 `src/services/agent-loader.service.ts` — add optional
  `entities: { kinds: string[] }` field on `agentRuleSchema`.
  Defaults to absent (route has no entity access).
- [ ] 6.2 Tool-call gating: when a route invokes any `entity.*`
  tool, Clawndom checks that the requested `kind` (for find/upsert)
  or the kind of the referenced entity (for get/relate/unrelate/
  purge) is in `entities.kinds`. Rejects out-of-scope calls with a
  clear error.
- [ ] 6.3 Resolver activation: the resolver runs on routes where
  `entities.kinds` is present. Routes without it get an unresolved
  event context (no `actor`).
- [ ] 6.4 Tests: in-scope tool calls succeed; out-of-scope rejected;
  resolver activation per route.

## 7. `{{ entity_model }}` renderer

- [ ] 7.1 `src/services/entities/entity-model-renderer.service.ts`
  — function that takes (loaded schemas, relations.json, kinds
  list) and emits a markdown handbook describing the in-scope
  kinds + relations.
- [ ] 7.2 Render structure (per kind): name + description, then a
  bulleted property list with required/optional markers, types,
  and descriptions from the schema.
- [ ] 7.3 Render structure (relations): one section listing the
  in-scope relations as `<from-kind> --<type> [{props}]--> <to-kind>`
  with descriptions from `relations.json`. Relations whose `from`
  or `to` kind is out of scope MUST be omitted.
- [ ] 7.4 Worker integration: when a route has `entities.kinds`,
  call the renderer before template render, pass the result into
  the template engine as `entity_model`.
- [ ] 7.5 No caching layer — generation is per-fire (~10ms cold).
  If profiling later shows it's a hotspot, add caching keyed on
  (kinds-list, schema-content-hash).
- [ ] 7.6 Tests: full render of all four Winston kinds; trimmed
  render with two kinds; relations correctly filtered to
  in-scope-only; schema description text surfaces in the handbook.

## 8. Interaction log (preserved from earlier proposal)

- [ ] 8.1 `src/services/interactions/interaction-log.service.ts` —
  `InteractionLog` class with `record(entry)` and `recent(actorId,
  limit)`. Backed by Redis sorted set: key
  `interactions:<agent_id>:<actor_id>`. Stranger entries use
  `interactions:<agent_id>:stranger:<email>`.
- [ ] 8.2 InteractionEntry shape: `{ id: ulid, actor_id, surface,
  route, inbound_text, outbound_summary, timestamp, trace_id }`.
  Outbound summary truncated at 500 chars.
- [ ] 8.3 Writer hook in `worker.service.ts` — at end-of-run, after
  audit emission, write to interaction log when the matched rule
  has `interactions:` opt-in. Failure to write is logged but does
  not fail the job.
- [ ] 8.4 Per-actor max length and daily prune.
- [ ] 8.5 Pre-render injection: when the matched rule has
  `interactions: { topN }`, call `recent` before render and pass
  the result as `interactions` in the template context.
- [ ] 8.6 Tests: write+read round-trip, max-length trim, stranger
  key separation, template gets `{{ interactions }}` only when
  opted in.

## 9. agency-tools: six entity tools

- [ ] 9.1 `agency_tools/entity/find/` — POSTs to
  `/api/agents/<agent>/entities` with search parameters
  (kind, name substring, alias match, status filter, JSON-path
  property filters).
- [ ] 9.2 `agency_tools/entity/get/` — fetches a single entity by
  ID, with optional `expand_relations` flag.
- [ ] 9.3 `agency_tools/entity/upsert/` — creates or updates an
  entity. Inputs: `kind` (required), `properties` (required,
  object), optional `id`.
- [ ] 9.4 `agency_tools/entity/relate/` — establishes a relation.
  Inputs: `from_id`, `type`, `to_id`, optional `properties`.
- [ ] 9.5 `agency_tools/entity/unrelate/` — breaks a relation.
- [ ] 9.6 `agency_tools/entity/purge/` — gated destructive tool.
  Routes that include it grant destructive access; the tool
  requires a non-empty `reason` string.
- [ ] 9.7 Each tool ships with smoke-test fixtures against a local
  Clawndom HTTP endpoint.
- [ ] 9.8 Each tool's `tool.yaml` uses only SPE-2078-accepted type
  primitives (string, number, boolean, array, object).

## 10. Read-only inspection endpoint

- [ ] 10.1 The `GET` endpoints from section 5 are the inspection
  surface. Add a short operator README documenting common curl
  invocations.

## 11. Verification

- [ ] 11.1 Local end-to-end: spin up clawndom-winston locally with
  workspace schemas in place. Populate the SQLite file via the
  workspace's migration script against a test spreadsheet. Send a
  synthetic Slack-format event from Heather; verify `actor.kind =
  team_member`. Verify `{{ entity_model }}` is populated.
- [ ] 11.2 Synthetic email event from a parent; verify
  `actor.kind = contact`, related client(s) populated.
- [ ] 11.3 Stranger case: synthetic event from an unknown email;
  verify `actor.kind = stranger`.
- [ ] 11.4 Cross-surface continuity: email-then-Slack from Heather
  yields a populated `{{ interactions }}` on the second event.
- [ ] 11.5 Out-of-scope rejection: route declares `entities.kinds:
  [client]`; agent calls `entity.find(kind='team_member')`; call
  rejected.
- [ ] 11.6 Deploy: merge → bump pinned agency-tools / winston-
  agency refs in `clawndom.env` per
  `[[agency-tools-pinned-sha]]` → restart clawndom-winston → tail
  logs.

## 12. Out of scope (deferred consciously)

- Cross-tenant federation.
- `entity.merge` tool (revisit if a sit-down audit identifies real
  need).
- `entity.export_to_sheet` tool (lands with the follow-on
  intake-flow proposal).
- Postgres backend.
- Auto-distillation from interaction log to memory namespace.
- The downstream workflows (intake webhook, scheduling, therapist
  onboarding, offboarding, nightly audit) — each its own follow-on
  change.

## Estimated effort

| Section | Days |
|---|---|
| 1. SQLite store + core service | 1.5 |
| 2. Schema loader + validator | 0.75 |
| 3. Internal identity resolver | 0.5 |
| 4. Surface-adapter hints | 0.5 |
| 5. HTTP endpoints | 1.0 |
| 6. Per-route `entities.kinds` enforcement | 0.5 |
| 7. `{{ entity_model }}` renderer | 0.75 |
| 8. Interaction log | 1.0 |
| 9. Six agency-tools tools | 1.0 |
| 10. Inspection endpoint | 0.0 (rolls up into 5) |
| 11. Verification | 0.5 |
| **Total (Clawndom)** | **~8.0 days** |

Workspace-side work (schemas, `relations.json`, migration script,
per-route `entities.kinds` declarations) lands in `winston-agency`
and is tracked separately. Estimate there: ~1.5 days for the four
schemas + relations.json + clawndom.yaml edits + migration script.

Coverage gate (95% statements / lines / functions, 88% branches)
adds ~1 day to the testing line items; included.
