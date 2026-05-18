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

- **NEW: Five canonical agent-facing tools** in agency-tools:
  - `entity.find` — search across kind, name, aliases, properties
  - `entity.get` — fetch by id with optional relation expansion
  - `entity.upsert` — create-or-update with natural-key dedup
  - `entity.relate` — establish a typed relation
  - `entity.unrelate` — break a relation
  Plus a gated **`entity.purge`** tool for cleanup of test/duplicate
  entities; routes that include it grant destructive access.

- **NEW: HTTP endpoints in Clawndom.** Bearer-gated, per-agent scoped:
  - `GET    /api/agents/:agent/entities` (list/search)
  - `GET    /api/agents/:agent/entities/:id` (fetch with optional expansion)
  - `POST   /api/agents/:agent/entities` (upsert)
  - `POST   /api/agents/:agent/entities/:id/relations` (relate)
  - `DELETE /api/agents/:agent/entities/:id/relations/:type/:to` (unrelate)
  - `GET    /api/agents/:agent/entities/audit?since=...` (entity audit log)

- **NEW: Internal `EntityResolver` service.** Runs at inbound ingestion,
  before route matching. Given `IdentityHints {email?, slack_user_id?,
  oidc_email?}` it scans entities whose schema declares an email-typed
  property (or a `slack_user_id` property), returns the matching entity
  as the `actor`. No separate config — the schemas are self-describing.

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
  `team_member`, `location`. Each authored as a JSON Schema in
  `winston-agency/workspaces/winston/schemas/`. School, doctor,
  insurer, drive_folder all deferred — data on existing kinds, not
  their own kinds, until a workflow demands first-class status.

- **PRESERVED: Cross-surface interaction log.** Same Redis-sorted-set
  design as the earlier proposal; `actor_id` is now an entity ID.
  Strangers continue to key on raw email. Per-route `interactions:
  { topN }` opt-in preserved.

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

- `cross-surface-interactions`: Per-actor turn log keyed on entity IDs.
  Routes opt into retrieval via `interactions: {topN}`; templates
  receive `{{ interactions }}` at render time.

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
- `src/services/interactions/interaction-log.service.ts`
- `src/types/actor.ts` — discriminated union
- Worker integration in `src/services/worker.service.ts` — resolver
  before render, `{{ entity_model }}` injection, interaction-log
  writer after run

**New code (agency-tools):**
- `agency_tools/entity/find/`
- `agency_tools/entity/get/`
- `agency_tools/entity/upsert/`
- `agency_tools/entity/relate/`
- `agency_tools/entity/unrelate/`
- `agency_tools/entity/purge/` (gated)

**New code (winston-agency — Winston-specific data model):**
- `workspaces/winston/schemas/client.schema.json`
- `workspaces/winston/schemas/contact.schema.json`
- `workspaces/winston/schemas/team_member.schema.json`
- `workspaces/winston/schemas/location.schema.json`
- `workspaces/winston/relations.json`
- `scripts/migrate-mcl-to-entities.py` (one-shot per tenant; reads
  the v2 MCL restructure built earlier, writes the per-tenant
  SQLite file; ships with a header notice that the agent's systemd
  service should be stopped before running)
- `clawndom.yaml` updates: per-route `entities.kinds` + tool additions

**New code (specs):**
- `openspec/specs/entity-store/spec.md`
- `openspec/specs/actor-resolution/spec.md`
- `openspec/specs/cross-surface-interactions/spec.md`

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
