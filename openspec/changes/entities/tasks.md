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
- [ ] 1.3 ID generator: `t_<slug>` and `loc_<slug>` are passed in by
  the caller (migration script + agent); `c_<base32-8>` and
  `p_<base32-8>` are generated when an upsert has no provided ID and
  no natural-key match found. Crockford base32 alphabet (no `i`,
  `l`, `o`, `u`).
- [ ] 1.4 Natural-key dedup in `upsert`: when caller does not supply
  `id`, the service computes the kind-specific natural key
  (`team_member`: lowercase email; `client`: legal name + DOB;
  `contact`: lowercase email, then (name, phone) fallback;
  `location`: slug) and looks up an existing entity. If found,
  updates; if not, creates with a fresh ID. Returns the entity ID.
- [ ] 1.5 Audit-log writer: every successful create / update / relate
  / unrelate / purge inserts one row into `entity_audit` with the
  before/after diff. Trace ID + actor (`'tool:entity.upsert'`,
  `'handler:intake'`, `'migration:initial'`) are passed in by the
  caller. Failure to write the audit row is a hard failure (the
  primary write is rolled back).
- [ ] 1.6 Last-writer-wins on `upsert`: when an existing entity is
  found, the new `properties` object replaces the existing one in
  full (the caller is responsible for sending the complete desired
  state). `created_at` is preserved; `updated_at` is set.
  Documented in the spec.
- [ ] 1.7 `purge` cascade: deletes the entity row, deletes outgoing
  `relations` rows, leaves incoming `relations` rows in place and
  records the list of orphaned incoming relations in the audit-log
  diff.
- [ ] 1.8 Tests: round-trip create, idempotent re-upsert on natural
  key, status-based filtering in `find`, relation expand on `get`,
  audit-log records exact diff, purge cascade behavior,
  concurrent-upsert safety under WAL.

## 2. Per-kind schemas

- [ ] 2.1 `src/services/entities/schemas/client.schema.json` — JSON
  Schema for the client kind. Required: `legal_name`, `dob`,
  `status`. Optional: `nickname`, `preferred_pronouns`, `address`,
  `started_at`, `ended_at`, `paperwork_status`, `paperwork_date`,
  `notes`. Status enum: `active | former | waitlist | discharged`.
- [ ] 2.2 `src/services/entities/schemas/contact.schema.json` — JSON
  Schema for the contact kind. Required: `name`, `role`, `status`.
  Optional: `email`, `phone`, `address`, `notes`. Role enum:
  `parent | guardian | self | other_caregiver`. Status enum:
  `active | inactive`.
- [ ] 2.3 `src/services/entities/schemas/team_member.schema.json` —
  Required: `name`, `email`, `status`, `role`. Optional:
  `slack_user_id`, `credentials`, `npi`, `malpractice_expires`.
  Role and status enums per the design.
- [ ] 2.4 `src/services/entities/schemas/location.schema.json` —
  Required: `name`, `status`. Optional: `address`, `kind` (school /
  office / home / telehealth), `notes`.
- [ ] 2.5 `src/services/entities/entity-schema.service.ts` — loads the
  schema files at boot, validates `properties` against the kind's
  schema on every `upsert`. Schemaless fallback when no schema file
  exists for a kind. Errors name the failing property and the
  constraint that failed.
- [ ] 2.6 Tests: each kind validates a known-good record, each kind
  rejects a known-bad record (missing required, wrong type, invalid
  enum). Schemaless fallback accepts an arbitrary object.

## 3. Internal identity resolver

- [ ] 3.1 `src/types/actor.ts` — discriminated `Actor` union:
  `team_member` (id, role, permissions, emails), `client` (id, name),
  `contact` (id, role, client_ids), `stranger` (id=null, email).
- [ ] 3.2 `src/services/entities/entity-resolver.service.ts` —
  `EntityResolver` class with `resolve(hints: IdentityHints):
  Promise<Actor>`. `IdentityHints` shape: `{ email?, slack_user_id?,
  oidc_email? }`.
- [ ] 3.3 Chain order: try `slack_user_id` against team_member
  entities; try `email`/`oidc_email` against team_member emails; try
  `email` against contact emails (returns a contact actor with the
  list of related client IDs); fall back to `{ id: null, kind:
  'stranger', email }`.
- [ ] 3.4 Reads go through the same `EntityStore` instance as the
  HTTP tools — no separate cache layer; SQLite's own page cache is
  sufficient at this scale.
- [ ] 3.5 Resolver result is attached to the event context as
  `actor`. Existing route-condition primitives already handle
  arbitrary field paths; document `actor.*` as a usable path.
- [ ] 3.6 Tests: each chain step, conflicting hints, missing
  matching entity, stranger fallback, contact resolves with
  populated `client_ids`.

## 4. Surface-adapter identity hints

- [ ] 4.1 `src/strategies/transport/slack-socket.transport.ts` —
  include `identityHints: { slack_user_id: event.user, email:
  <resolved via users.info if cached, else undefined> }`. Don't
  synchronously call `users.info` per inbound; rely on the
  team_member `slack_user_id` field for the common case.
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
  per-agent scope. Bearer-token gated (the same internal-tool
  bearer that other Clawndom tool endpoints use).
- [ ] 5.3 Zod request validation in the controller. The store rejects
  schema-invalid properties; the controller rejects
  protocol-invalid requests (missing required fields, wrong
  content-type, etc.). Errors return 400 with the same shape as
  existing controllers.
- [ ] 5.4 Tests: each endpoint round-trips, auth failure, bad
  payload, expand-relations populates correctly, audit endpoint
  filters by `since`.

## 6. Per-route config

- [ ] 6.1 `src/services/agent-loader.service.ts` — add optional
  `entities: boolean` field on `agentRuleSchema`. Defaults to
  `false`. Add optional `interactions: { topN }` (carried over from
  the earlier proposal).
- [ ] 6.2 Routes with `entities: true` run the resolver at inbound
  time; routes without it skip the resolver and get an unresolved
  event context (no `actor`).
- [ ] 6.3 Optional top-level `interactions:` block:
  `{ maxLogLength: 200, retainDays: 180 }`. Per-agent knobs.
- [ ] 6.4 Tests: rule with `entities: true` gets a resolved actor;
  rule without it doesn't; schema rejects bad values.

## 7. agency-tools: four entity tools

- [ ] 7.1 `agency_tools/entity/find/tool.yaml` + `impl.py` — SPE-2078
  tool that POSTs to `/api/agents/<agent>/entities` with search
  parameters (kind, name substring, status filter, JSON-path
  property filters). Returns the matching entities as a JSON list.
- [ ] 7.2 `agency_tools/entity/get/tool.yaml` + `impl.py` — fetches a
  single entity by ID, with optional `expand_relations` flag.
- [ ] 7.3 `agency_tools/entity/upsert/tool.yaml` + `impl.py` —
  creates or updates an entity. Inputs: `kind` (required),
  `properties` (required, object), optional `id` (when caller wants
  to address an existing entity directly). Returns the entity ID and
  the (post-write) full record.
- [ ] 7.4 `agency_tools/entity/relate/tool.yaml` + `impl.py` —
  establishes a relation. Inputs: `from_id`, `type`, `to_id`,
  optional `properties`. Returns `ok` or the conflict.
- [ ] 7.5 (Stretch, optional in this change) `entity/unrelate/` and
  `entity/purge/` tools. Purge requires a `reason` string and is
  intended only for cleanup; gated behind an audit-friendly tool
  metadata flag if needed.
- [ ] 7.6 Each tool ships with smoke-test fixtures against a local
  Clawndom HTTP endpoint (same pattern as `dispatch_task` and
  `scheduled_tasks.*`).
- [ ] 7.7 Each tool's `tool.yaml` uses only the SPE-2078-accepted
  type primitives (string, number, boolean, array, object). No
  `type: integer`.

## 8. Interaction log (preserved from earlier proposal)

- [ ] 8.1 `src/services/interactions/interaction-log.service.ts` —
  `InteractionLog` class with `record(entry)` and `recent(actorId,
  limit)`. Backed by Redis sorted set: key
  `interactions:<agent_id>:<actor_id>`, score `timestamp_ms`, member
  JSON of the entry. Stranger entries use
  `interactions:<agent_id>:stranger:<email>`.
- [ ] 8.2 InteractionEntry shape: `{ id: ulid, actor_id, surface,
  route, inbound_text, outbound_summary, timestamp, trace_id }`.
  Outbound summary truncated at 500 chars.
- [ ] 8.3 Writer hook in `worker.service.ts` — at end-of-run, after
  audit emission, write to interaction log when the matched rule
  has `interactions:` opt-in. Strangers write to the stranger key.
  Failure to write is logged but does not fail the job.
- [ ] 8.4 Per-actor max length and daily prune (carried from the
  earlier design).
- [ ] 8.5 Pre-render injection: when the matched rule has
  `interactions: { topN }`, call `recent` before render and pass
  the result as `interactions` in the template context.
- [ ] 8.6 Tests: write+read round-trip, max-length trim, stranger
  key separation, template gets `{{ interactions }}` only when
  opted in.

## 9. Migration script

- [ ] 9.1 `scripts/migrate-mcl-to-entities.py` — one-time script.
  Inputs: spreadsheet ID for the MCL, spreadsheet ID for the
  Therapists/Staff sheet, output SQLite path. Optional Slack
  user-ID overrides file (operator-supplied JSON).
- [ ] 9.2 Reads the MCL via the canonical v2 restructure shape
  (the deduplicated Clients / Contacts / Therapists / Locations
  tabs already prepared in `/tmp/master_client_log_v2.xlsx` from
  the earlier work).
- [ ] 9.3 Upserts entities in this order: locations → team_members →
  clients → contacts. Then upserts relations (`has_therapist`,
  `has_parent`, `seen_at`).
- [ ] 9.4 Idempotent: re-running against a populated SQLite file
  updates existing entities rather than duplicating. Natural-key
  dedup carries this for free.
- [ ] 9.5 Reports on stdout: how many entities created vs updated by
  kind; how many relations established; any rows skipped (with the
  reason).
- [ ] 9.6 Tests against a fixture spreadsheet that exercises the
  multi-kid family case, the adult-self-client case, and a row
  with a typo in the therapist column (should warn, not crash).

## 10. Read-only inspection endpoint

- [ ] 10.1 The `GET` endpoints from section 5 are the inspection
  surface. Add a small operator README pointing at the curl
  invocations: `curl … /api/agents/winston/entities?kind=client` for
  the active-client list, `… ?status=former` for the offboarded
  list, etc.
- [ ] 10.2 No HTML rendering, no auth proxy, no human-facing UI.
  Operator only.

## 11. winston-agency config + template updates

- [ ] 11.1 `workspaces/winston/clawndom.yaml` — add the four entity
  tools to the slack-winston chat rule, the email-chat rule, and
  any scheduled rule that needs them. Add `entities: true` and
  `interactions: { topN: 5 }` on chat-style rules.
- [ ] 11.2 Drop the `team:` and `clientLookup:` blocks (they aren't
  introduced in this change; the entity store subsumes them).
  Drop any references in templates to fields those blocks would
  have supplied.
- [ ] 11.3 Update `templates/slack-chat.md` and
  `templates/email-chat.md` to consult `{{ interactions }}` at the
  top of the run, and to reference `{{ actor.role }}`,
  `{{ actor.id }}` instead of regex-matching emails in prose.
- [ ] 11.4 Re-render the README routing graph (CI catches drift; do
  this before pushing).

## 12. Verification

- [ ] 12.1 Local end-to-end: spin up clawndom-winston locally,
  populate the SQLite file via the migration script against a test
  spreadsheet, send a synthetic Slack-format event from Heather,
  verify `actor.kind = team_member`, `actor.role = owner`. Verify
  the interaction log entry is recorded.
- [ ] 12.2 Synthetic email event from a parent in the test fixture;
  verify `actor.kind = contact`, `actor.client_ids` populated.
- [ ] 12.3 Stranger case: synthetic event from an unknown email;
  verify `actor.kind = stranger`, interaction log uses the
  stranger key.
- [ ] 12.4 Cross-surface continuity: send a synthetic email from
  Heather, then a synthetic Slack DM from Heather, verify the
  second event's render context has the first event's interaction
  as `{{ interactions }}`.
- [ ] 12.5 Migration smoke: run the migration against the real
  Winston MCL; spot-check that Heather, Bethany, the recently-fixed
  Lillian Cagle row, and the recently-fixed Hephzibah Okafor row
  all round-trip into entities correctly.
- [ ] 12.6 Deploy: merge → bump pinned agency-tools / winston-agency
  refs in `clawndom.env` per [[agency-tools-pinned-sha]] → restart
  clawndom-winston → tail logs.

## 13. Out of scope (deferred consciously)

- The four downstream workflows (intake webhook, scheduling,
  therapist onboarding, offboarding, nightly audit) each land as
  their own follow-on change that uses the entity store.
- Cross-tenant federation.
- Auto-distillation from interaction log to memory namespace.
- `entity.merge` tool for handling typo duplicates.
- Operator UI; the JSON inspection endpoint is the operator surface.
- Postgres backend; SQLite is sufficient at this scale.

## Estimated effort

| Section | Days |
|---|---|
| 1. SQLite store + core service | 1.5 |
| 2. Per-kind schemas | 0.5 |
| 3. Internal identity resolver | 0.5 |
| 4. Surface-adapter hints | 0.5 |
| 5. HTTP endpoints | 1.0 |
| 6. Per-route config | 0.25 |
| 7. Four agency-tools tools | 1.0 |
| 8. Interaction log | 1.0 |
| 9. Migration script | 1.0 |
| 10. Inspection endpoint | 0.0 (rolls up into 5) |
| 11. winston-agency config + templates | 0.75 |
| 12. Verification | 0.5 |
| **Total** | **~8.5 days** |

Coverage gate (95% statements / lines / functions, 88% branches)
adds ~1 day to the testing line items; included.
