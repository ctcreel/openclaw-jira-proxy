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
location, and the relationships between them. That representation needs
to support natural queries ("what do I know about Joey Asher?", "which
clients does Bethany see at MV on Tuesdays?", "any team members with
credentials expiring in 60 days?") and natural mutations ("Lily is done
after May 30", "we're adding Sarah Chen as a contractor", "Heather is
reassigning Carter to Alisha").

The current MCL is the wrong shape for this. It's a sheet because Piper was
a human who needed a UI; the next step is a knowledge base for a software
agent who doesn't.

This change introduces that knowledge base — a per-tenant entity store
plus the agent-facing tools to query and mutate it — and rewires every
identity-driven part of the system to read from it. It subsumes the
earlier `identity-and-interactions` proposal (TeamRegistry +
ClientLookup + InteractionLog as three coupled features) into one
substrate: the entity store. The InteractionLog stays as a separate
time-series append-only log, but its identity field references entity
IDs from the store, so the two are tightly coupled by design.

The same machinery serves every downstream workflow the agent does:
client intake (currently a 700-line Apps Script), scheduling
recurring sessions, therapist onboarding, offboarding, nightly audit.
Each is "route + template + tool set"; the entity store is the
shared substrate.

## What Changes

- **NEW: Per-tenant entity store.** SQLite file at
  `/home/ubuntu/.clawndom-<agent>/entities.db`. Two tables:
  - `entities (id, kind, name, properties JSON, created_at, updated_at)`
  - `relations (from_id, type, to_id, properties JSON, created_at)` with
    composite primary key
  Indexes on `kind`, `name`, `type`, `to_id`. JSON columns absorb everything
  that doesn't deserve a dedicated column yet; new properties don't
  require schema migration.

- **NEW: Per-kind schema validation.** For each entity kind, Clawndom
  ships a JSON Schema (`client.schema.json`, `contact.schema.json`,
  `team_member.schema.json`, `location.schema.json`). `entity.upsert`
  rejects properties that don't match. New kinds are added by dropping
  a new schema file. Properties default to schemaless if no schema
  exists for a kind.

- **NEW: Four agent-facing SPE-2078 tools** in
  `agency-tools/agency_tools/entity/`:
  - `entity.find` — fuzzy + structured search across kind/name/properties/relations
  - `entity.get` — fetch by id with optional N-hop relation expansion
  - `entity.upsert` — create-or-update with natural-key dedup
  - `entity.relate` / `entity.unrelate` — establish or break a relationship
  Each is a thin Python wrapper over Clawndom HTTP endpoints (same shape
  as `dispatch_task` and `scheduled_tasks.*`).

- **NEW: HTTP endpoints in Clawndom.** Bearer-gated, per-agent scoped:
  - `GET    /api/agents/:agent/entities` (list/search)
  - `GET    /api/agents/:agent/entities/:id` (fetch with optional expansion)
  - `POST   /api/agents/:agent/entities` (upsert)
  - `POST   /api/agents/:agent/entities/:id/relations` (relate)
  - `DELETE /api/agents/:agent/entities/:id/relations/:type/:to` (unrelate)
  - `GET    /api/agents/:agent/entities/audit?since=...` (entity audit log)

- **NEW: Internal `IdentityResolver` service.** Runs at inbound ingestion,
  before route matching. Given `IdentityHints {email?, slack_user_id?, oidc_email?}`
  resolves to an entity from the store. Attaches `actor` to the event
  context (same `Actor` discriminated union as the earlier proposal, but
  the source is now the entity store, not separate TeamRegistry/ClientLookup
  abstractions). The resolver IS NOT an agent-facing tool — it's framework
  code reading the same store the tools read.

- **NEW: Entity audit log.** Every write (`upsert`, `relate`, `unrelate`,
  status change) produces an audit record: timestamp, trace_id, source
  (tool/handler), entity_id, diff (before/after properties). Stored as a
  separate SQLite table; never pruned automatically. This replaces "rely
  on Sheets version history" as the recovery mechanism.

- **NEW: Soft-delete via `status` property.** Hard-delete from the
  entity store is reserved for `entity.purge` (separate tool, separate
  audit trail, intended for test/duplicate cleanup). The default
  offboarding flow is `entity.upsert(id=..., status='former', ended_at=...)`
  — the entity persists, relations persist, audit history persists, but
  queries that filter by `status='active'` skip it.

- **NEW: Initial kinds shipped (narrow):** `client`, `contact`,
  `team_member`, `location`. Each with a JSON Schema spelling out
  required + optional properties + natural keys. School, doctor,
  insurer, drive_folder all deferred — they're data on existing
  kinds, not their own kinds, until a workflow demands first-class
  status.

- **NEW: Per-route `entities:` opt-in on `clawndom.yaml` routes.** Routes
  declare whether the entity tools should be in their MCP bundle. Schedule
  routes that need it (e.g., the nightly audit) declare it; chat routes
  that work with people (slack-winston, email-chat) declare it; rules
  that don't (refresh-gmail-watch) don't.

- **MIGRATED: TeamRegistry inlined in clawndom.yaml.** The previous
  `team:` block disappears. Team members become entities with `kind:
  'team_member'`. The big-bang migration script reads the existing
  Therapists/Staff sheet (and operator-allowlist values) and writes
  entities + relations.

- **MIGRATED: ClientLookup sheets-source dropped.** The Google Sheet MCL
  is no longer Winston's source of truth. The migration reads it once
  (using the v2 restructure shape built earlier with the deduplicated
  Contacts table and normalized therapist FKs), writes entities +
  relations into the SQLite store. Sheets becomes a historical artifact;
  Winston stops reading from it on the next deploy after migration.

- **PRESERVED: Interaction log.** Same shape as the earlier proposal
  (Redis sorted set per actor, time-scored, append-only), but `actor_id`
  is an entity ID. Strangers continue to key on raw email since they
  don't yet have entities. Per-route `interactions: { topN }` opt-in
  preserved.

- **NEW: Read-only inspection endpoint.** `GET /api/agents/:agent/entities`
  renders the store as JSON for debug/inspection. No human-facing UI; the
  endpoint plus `curl` is the operator surface. Heather doesn't see it
  unless something's broken.

## Capabilities

### New Capabilities

- `entity-store`: Per-tenant SQLite-backed knowledge base of proper nouns
  with kind-typed entities, typed relations, schema validation, soft-
  delete via status, and an audit log. Four agent-facing tools plus
  internal resolver access.

- `actor-resolution`: Inbound events are resolved to canonical entities
  before route matching. Routes condition on `actor.kind`, `actor.role`,
  `actor.permissions`, `actor.id`. Strangers fall through with `actor.id
  = null`.

- `cross-surface-interactions`: Per-actor turn log keyed on entity IDs.
  Routes opt into retrieval via `interactions: {topN}`; templates receive
  `{{ interactions }}` at render time.

### Modified Capabilities

(none — this change is additive at the runtime level; existing routes
without entity-store opt-in keep their current behavior. The migration
itself is a one-time data move.)

## Impact

**New code (clawndom):**
- `src/services/entities/` — `entity-store.service.ts` (SQLite wrapper),
  `entity-schema.service.ts` (per-kind JSON Schema validation),
  `entity-audit.service.ts` (write-log), `entity-resolver.service.ts`
  (the framework-internal resolver)
- `src/controllers/entities.controller.ts` — six HTTP handlers
- `src/routes/entities.routes.ts` — route mounting
- `src/services/interactions/interaction-log.service.ts` — preserved
  from earlier proposal, references entity IDs
- `src/types/actor.ts` — discriminated union
- Worker integration in `src/services/worker.service.ts` — resolver
  before render, interaction-log writer after run

**New code (agency-tools):**
- `agency_tools/entity/find/`
- `agency_tools/entity/get/`
- `agency_tools/entity/upsert/`
- `agency_tools/entity/relate/`
- (and `agency_tools/entity/unrelate/`, `agency_tools/entity/purge/` if scope grows)

**New code (specs):**
- `openspec/specs/entity-store/spec.md`
- `openspec/specs/actor-resolution/spec.md`
- `openspec/specs/cross-surface-interactions/spec.md`

**Migrations:**
- One-time script `scripts/migrate-mcl-to-entities.py` reads:
  - Existing Google Sheet MCL (current Active + Inactive tabs)
  - The Therapists/Staff sheet
  - The v2 restructure (clean Contacts table, normalized therapist FKs,
    built earlier in `/tmp/master_client_log_v2.xlsx`) as the canonical
    pre-import shape
- Writes entities + relations to the per-tenant SQLite file.
- Per-tenant invocation at tenant provisioning.

**Affected configuration:**
- `clawndom.yaml` gains optional `entities:` top-level block with kind
  configurations and per-route `entities: true` opt-in.
- The previously-discussed `team:` + `clientLookup:` blocks are not
  introduced; entities subsume both.

**New runtime dependencies:** `better-sqlite3` (already in clawndom's
package.json). No new external dependencies.

**Affected APIs:** new internal HTTP endpoints. No change to existing
webhook controllers — they get entity tools as part of their per-route
`tools:` declaration, but the webhook routes themselves are unchanged.

**Migration-free at the runtime level:** existing agents without
`entities:` opt-in (system-agents like Builder, scheduled-prompt-only
agents) parse and run unchanged. The entity store is opt-in per agent.

**Per-tenant operator work at deploy:**
- Run the migration script once against the tenant's MCL
- Add `entities:` block to the agent's clawndom.yaml
- Bump pinned agency-tools ref (see the agency-tools-pinned-sha memory)
  so the new entity tools are reachable
- Restart clawndom-<agent>.service
