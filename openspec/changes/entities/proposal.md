## Why

Winston is replacing Piper, TALK's office manager. Piper's job was to be the
single source of truth for *everything about the practice that needed to be
remembered* — clients, parents, therapists, locations, schedules, billing
context, who said what to whom. Today that context lives in three lossy
places:

1. **Piper's head** (now leaving)
2. **A flat Google Sheet** (the Master Client Log — created by Piper as a hand-
   maintained track-everything sheet) with mixed schemas, typos, duplicates,
   and no foreign-key integrity
3. **Heather's inbox + calendar + scattered Drive folders** — accurate but
   unstructured

Winston cannot serve Heather the way Piper did unless he has a structured,
queryable, mechanically-maintained representation of the practice's
proper nouns: every client, every contact, every team member, every
location, and the relationships between them.

The current MCL is the wrong shape for this. It's a sheet because Piper was
a human who needed a UI; the next step is a knowledge base for a software
agent who doesn't.

This change introduces that knowledge base as a substrate in Clawndom plus
a workspace-side data model authored per agent. Clawndom ships the entity
store machinery (storage, tools, HTTP, audit); each agent's workspace
declares its own kinds, relations, and resolver config via JSON Schema +
config files. The same machinery serves Winston (client/contact/team_member/
location), Patch (pr/contributor/repository), and any future agent — only
the schemas differ.

The change also rebuilds the identity resolver and the cross-surface
interaction log on top of the entity store, replacing the earlier
`identity-and-interactions` decomposition (TeamRegistry + ClientLookup +
InteractionLog as three coupled features) with one substrate plus two
consumers of it.

## Substrate vs. Workspace

The split is the architectural backbone of this change:

**Clawndom (substrate, agent-agnostic):**
- SQLite storage (entities + relations + entity_audit tables)
- The five generic tools (`find`, `get`, `upsert`, `relate`, `unrelate`)
  plus a gated `purge` tool
- Generic JSON Schema validator
- HTTP endpoints under `/api/agents/:agent/entities`
- The `EntityResolver` service (framework-internal, reads the same store)
- The `{{ entity_model }}` template renderer (reads workspace schemas,
  emits a markdown handbook per route)
- The cross-surface interaction log

**Agent workspace (data model, agent-specific):**
- JSON Schema files — one per kind — defining required + optional
  properties, types, format constraints
- A `relations.json` declaring relation types and their property shapes
- `identityResolver:` block in `clawndom.yaml` is *not needed*; the
  resolver auto-discovers email-typed properties from the schemas
- Per-tenant migration script (e.g., `winston-agency/scripts/migrate-mcl-to-entities.py`)
- Per-route `entities.kinds:` declaration on each route that uses entity tools

Adding a new entity kind for Winston is "drop a JSON Schema in the workspace,
restart, done" — zero Clawndom changes.

## What Changes

- **NEW: Per-tenant SQLite entity store.** File at
  `/home/ubuntu/.clawndom-<agent>/entities.db`. Two tables (`entities`,
  `relations`) plus an `entity_audit` table. JSON columns absorb
  everything that isn't a key, index, or audit field. WAL mode for
  concurrent reads during writes.

- **NEW: Workspace-declared schemas.** Each agent's workspace ships
  JSON Schema files for the kinds it uses. Clawndom loads them at boot
  via the workspace path. `entity.upsert` validates `properties`
  against the kind's schema before write. Kinds without a schema fall
  through to schemaless validation. ISO-8601 (`YYYY-MM-DD`) is the
  required date format wherever a property declares `"format": "date"`.

- **NEW: Workspace-declared relations.** `relations.json` in the
  workspace declares each relation type's `from` kind, `to` kind, and
  optional property shape. Drives spec validation (`entity.relate`
  rejects unknown relation types) and the `{{ entity_model }}`
  renderer.

- **NEW: Two layers of agent-facing tools.**

  **Generic substrate tools** (six total) — used by Clawndom internals,
  by migration scripts, and by routes that need structured operations:
  - `entity.find` — relation-aware search: `kinds[]`, `q` (name/alias
    substring), `related_to` + `relation_type`, `text_match` (FTS5
    over `entities.properties`), `order` (e.g., `created_at desc`),
    `limit`
  - `entity.get` — fetch by id with optional relation expansion
  - `entity.upsert` — create-or-update with natural-key dedup
  - `entity.relate` — establish a typed relation
  - `entity.unrelate` — break a relation
  - `entity.purge` — gated destructive tool; routes that include it
    grant cleanup access

  **Domain-shaped wrappers** (Winston's daily surface) — thin SPE-2078
  tools that compose the substrate tools so Winston doesn't think in
  data-model terms:
  - `remember(thing_to_remember, about_entity)` — writes a `memory`
    entity, tags `--about-->` to the referenced entity
  - `forget(memory_id_or_match, about_entity)` — soft-deletes a memory
    (`status='forgotten'`); audit log preserves it
  - `recall(about_entity, limit?)` — finds memories about an entity,
    newest first

  Winston's mental model: "I want to remember X about Y" → `remember(X,
  Y)`. He never thinks "construct an entity of kind memory and relate
  it via about." The wrappers carry that translation.

- **NEW: HTTP endpoints in Clawndom.** Bearer-gated, per-agent scoped:
  - `GET    /api/agents/:agent/entities` (list/search)
  - `GET    /api/agents/:agent/entities/:id` (fetch with optional expansion)
  - `POST   /api/agents/:agent/entities` (upsert)
  - `POST   /api/agents/:agent/entities/:id/relations` (relate)
  - `DELETE /api/agents/:agent/entities/:id/relations/:type/:to` (unrelate)
  - `GET    /api/agents/:agent/entities/audit?since=...` (entity audit log)

- **NEW: Internal `EntityResolver` service with strategy pattern.**
  Runs at inbound ingestion, before route matching. Resolution is a
  strategy pattern keyed on identity-hint type — one strategy per
  hint:
  - `EmailResolverStrategy` (today: gmail-pubsub)
  - `SlackUserIdResolverStrategy` (today: slack-socket)
  - `PhoneResolverStrategy` (forward-looking: Twilio SMS)
  - `OidcEmailResolverStrategy` (forward-looking: MCP server route)

  Each strategy declares its `hintName` + `propertyFormat` (the JSON
  Schema `"format"` value it matches against) + extraction +
  normalization rules. At boot, the orchestrator cross-references
  each strategy's `propertyFormat` against the workspace schemas to
  build a map of which kinds participate. At inbound time, strategies
  run in priority order; first hit wins.

  The actor IS the resolved entity — kind + id + name + the entity's
  own properties. No relation-walking enrichment; route conditions
  predicate on `actor.kind` / `actor.role` / etc. directly, and any
  related-entity lookups (e.g., "which clients is this contact for")
  happen on demand via tool calls during the run.

- **NEW: Entity audit log.** Every successful create/update/relate/
  unrelate/purge inserts one row into `entity_audit` with timestamp,
  trace_id, actor, entity_id, op, and a JSON diff of the before/after
  state. Audit-row write failure rolls back the primary write.

- **NEW: Soft-delete via `status` property.** Hard-delete is reserved
  for `entity.purge(id, reason)`. The default offboarding flow is
  `entity.upsert(id=..., status='former', ended_at=<date>)`; the
  entity persists, relations persist, audit history persists, and
  queries that filter `status='active'` skip it.

- **NEW: Per-route `entities.kinds` declaration.** A route that uses
  the entity tools must declare which kinds are in scope:

  ```yaml
  - name: handle-cancellation
    entities:
      kinds: [client, contact, team_member]
    tools:
      - module.python: agency_tools.entity.find
      - module.python: agency_tools.entity.get
      # no upsert/relate → read-only by virtue of tool absence
  ```

  Two axes of access combine: `entities.kinds` (which kinds Winston
  can touch on this route) × `tools:` (which operations Winston can
  perform). Together they form a clean access matrix without needing
  a separate read/write config — read-only is just "include find/get,
  omit upsert/relate."

- **NEW: `{{ entity_model }}` template renderer.** When a route has
  `entities.kinds`, Clawndom synthesizes a markdown handbook from the
  workspace schemas + `relations.json`, filtered to the kinds in
  scope, and exposes it as `{{ entity_model }}` in the template
  context. The template author chooses where to inject the handbook.
  Regenerated per fire (~10ms cold); no caching needed.

- **NEW: Initial Winston kinds (narrow):** `client`, `contact`,
  `team_member`, `location`, plus `memory` and `interaction` (which
  are entity kinds in the unified model, not separate stores). Each
  authored as a JSON Schema in
  `winston-agency/workspaces/winston/schemas/`. School, doctor,
  insurer, drive_folder all deferred — data on existing kinds, not
  their own kinds, until a workflow demands first-class status.

- **NEW: Memories and interactions are entity kinds.** No separate
  Redis store, no separate memory namespace. Both are entities with
  schemas (`memory.schema.json`, `interaction.schema.json`) and
  participate in relations:
  - `memory --about--> <any entity>` — what the memory is about
  - `interaction --from--> contact|team_member` — who said it
  - `interaction --about--> <any entity>` — what was mentioned
  
  Same store, same tools, same audit log. Retrieval is via
  relation-aware `entity.find` queries — "recent memories about
  Camilla" is just `find(kinds=[memory], related_to='c_camilla',
  relation_type='about', order=created_at desc, limit=5)`.

- **NEW: Interactions are framework-written, not agent-called.** The
  worker writes one `interaction` entity per chat turn automatically
  (after audit emission, before job completion). The agent never
  calls an interaction tool — interactions happen as a side effect
  of any chat-style route firing. Failure to write is logged but
  does not fail the job.

- **NEW: Post-turn deterministic entity-mention extractor.** After
  each chat-style turn, Clawndom scans the inbound + outbound text
  for tokens that match the `name` or `aliases` of existing entities
  in the store. Single unambiguous match → tag the interaction with
  an `--about-->` relation. Ambiguous matches → skip (interaction
  remains findable by actor). Acceptable coverage gap; actor anchor
  always works.

- **NEW: FTS5 text search on `entities.properties`.** SQLite full-
  text index over the JSON-stringified properties of each entity.
  Backs `entity.find(text_match='...')` for keyword queries that
  aren't anchored to a known entity ("anything mentioning
  'cancellation policy'"). Keyword-level, not semantic; sufficient
  for the use cases that come up in practice. Real semantic search
  (embeddings) deferred until a use case demands it.

- **NEW: Read-only inspection endpoint.** `GET /api/agents/:agent/entities`
  is the operator surface for "what's in the store right now." No
  human-facing UI.

- **DEFERRED (follow-on change): `entity.export_to_sheet` tool.**
  Renders the current store state into a familiar-looking Google
  Sheet for sit-down audits with the practice owner. The sheet is a
  display, never edited; the operator dictates corrections to
  Winston in Slack and Winston runs the corresponding
  `entity.upsert` / `entity.relate` calls. Lands in the follow-on
  intake-flow change.

## Capabilities

### New Capabilities

- `entity-store`: Per-tenant SQLite-backed knowledge base with workspace-
  declared kinds, typed relations, schema validation, soft-delete via
  status, audit log, five canonical tools, gated purge, and a
  per-fire-rendered `{{ entity_model }}` handbook.

- `actor-resolution`: Inbound events are resolved to canonical entities
  before route matching. The resolver auto-discovers email-typed
  properties from the workspace schemas; no separate config.

- `cross-surface-interactions` capability is rolled into `entity-store`
  — interactions are an entity kind, not a separate capability. Routes
  opt into `{{ interactions }}` injection via `interactions: { topN }`;
  Clawndom internally fetches via `entity.find(kinds=[interaction],
  related_to=actor.id, relation_type='from')` plus, for actors with
  related clients, `(or about IN actor.client_ids)` — same template
  experience, no separate spec.

### Modified Capabilities

(none — this change is additive at the runtime level.)

## Impact

**New code (clawndom — substrate):**
- `src/services/entities/` — `entity-store.service.ts` (SQLite wrapper),
  `entity-schema.service.ts` (JSON Schema validator),
  `entity-audit.service.ts` (write log), `entity-resolver.service.ts`
  (framework-internal resolver), `entity-model-renderer.service.ts`
  (per-fire `{{ entity_model }}` generator)
- `src/controllers/entities.controller.ts` — six HTTP handlers
- `src/routes/entities.routes.ts` — route mounting
- `src/services/entities/interaction-writer.service.ts` — post-turn
  worker hook that writes one `interaction` entity per chat-style
  run and runs the entity-mention extractor
- `src/services/entities/entity-mention-extractor.service.ts` —
  deterministic post-turn pass that tags `--about-->` relations on
  the interaction by scanning the inbound/outbound text for entity
  name/alias matches
- `src/types/actor.ts` — discriminated union
- Worker integration in `src/services/worker.service.ts` — resolver
  before render, `{{ entity_model }}` injection, interaction-log
  writer after run

**New code (agency-tools — generic substrate tools):**
- `agency_tools/entity/find/`
- `agency_tools/entity/get/`
- `agency_tools/entity/upsert/`
- `agency_tools/entity/relate/`
- `agency_tools/entity/unrelate/`
- `agency_tools/entity/purge/` (gated)

**New code (agency-tools — domain-shaped wrappers):**
- `agency_tools/remember/` — wraps upsert(kind=memory) + relate
- `agency_tools/forget/` — wraps upsert(memory_id, status='forgotten')
- `agency_tools/recall/` — wraps find(kinds=[memory], related_to=...)

**New code (winston-agency — Winston-specific data model):**
- `workspaces/winston/schemas/client.schema.json`
- `workspaces/winston/schemas/contact.schema.json`
- `workspaces/winston/schemas/team_member.schema.json`
- `workspaces/winston/schemas/location.schema.json`
- `workspaces/winston/schemas/memory.schema.json`
- `workspaces/winston/schemas/interaction.schema.json`
- `workspaces/winston/relations.json` — declares `has_therapist`,
  `had_previous_therapist`, `seen_at`, `has_contact`, `about`, `from`
- `scripts/migrate-mcl-to-entities.py` (one-shot per tenant; reads
  the v2 MCL restructure built earlier, writes the per-tenant
  SQLite file; ships with a header notice that the agent's systemd
  service should be stopped before running)
- `clawndom.yaml` updates: per-route `entities.kinds` + tool additions

**New code (specs):**
- `openspec/specs/entity-store/spec.md`
- `openspec/specs/actor-resolution/spec.md`
- (no separate cross-surface-interactions spec — folded into
  entity-store as interactions are an entity kind)

**Affected configuration:**
- `clawndom.yaml` (per-agent): per-route `entities.kinds` declarations
  on rules that use entity tools. No top-level `entities:` block or
  resolver config needed — schemas describe themselves.

**New runtime dependencies:** `better-sqlite3` (already in clawndom's
package.json). No new external dependencies.

**Migration-free at the runtime level:** existing agents without any
`entities.kinds` declarations parse and run unchanged. The entity
store is opt-in per route.

**Per-tenant operator work at deploy:**
1. Author / verify the workspace's schemas + `relations.json` (one-time
   per workspace, not per tenant)
2. Stop `clawndom-<agent>.service`
3. Run the workspace's migration script against the tenant's MCL
4. Add `entities.kinds` + entity tools to each chat-style route in the
   tenant's `clawndom.yaml`
5. Bump pinned agency-tools ref per `[[agency-tools-pinned-sha]]`
6. Start `clawndom-<agent>.service`
