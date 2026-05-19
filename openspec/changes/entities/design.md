## Context

Winston serves a small speech-therapy practice. Today the practice's
proper-noun data is split between Piper's head, the hand-maintained
Master Client Log, the Therapists/Staff sheet, and Heather's
inbox/calendar/Drive. Piper disambiguates "Bethany" by context; Winston
cannot. He needs typed, related, queryable data with stable identifiers
across surfaces.

The previous design pass (`identity-and-interactions`) introduced three
separate features for this: TeamRegistry (declarative YAML), ClientLookup
(a Sheets-backed read-only port), and InteractionLog (Redis turn log).
That decomposition was sound when the only consumers were the identity
resolver and the cross-surface continuity case. It does not scale to the
full vision: Heather replaces Piper with Winston, and Winston handles
intake, scheduling, offboarding, onboarding, and audit. Every one of those
workflows reads and writes the same shape of data — typed entities and
typed relations between them. Three abstractions collapse into one.

The architectural backbone of this change is the **substrate / workspace
split**: Clawndom ships generic entity-store machinery (storage, tools,
HTTP, audit, resolver, renderer); each agent's workspace declares its
own kinds and relations via JSON Schema files. Adding a new entity kind
is a workspace edit, not a Clawndom release.

## Goals / Non-Goals

**Goals:**

- A single typed, queryable substrate for proper nouns. Same SQLite
  shape works for any agent's domain.
- Stable per-tenant IDs across surfaces and over time.
- Workspace-declared schemas; Clawndom never hardcodes a domain kind.
- Schema validation enforced at write time; date/email/etc. format
  constraints carried by the schemas.
- Soft-delete by default; hard-delete (`purge`) is a gated tool.
- Tight coupling with the identity resolver and the interaction log;
  both read the same store.
- Per-tenant scoping; each clawndom instance owns its own SQLite file.
- Big-bang migration per tenant. Pre-production today; no operational
  SLA to honor.
- Per-route declaration of which kinds are in scope; trimmed
  `{{ entity_model }}` handbook injected automatically.

**Non-Goals:**

- A graph database. Two SQL tables cover every query at this scale.
- A human-facing UI. Operator inspection is the JSON endpoint plus
  `curl`. Practice owners interact via the agent.
- Cross-workspace federation.
- Full RDF or ontology compatibility.
- Generic CRUD UI generation.
- Migration tools for the downstream workflows (intake, scheduling,
  offboarding, onboarding, audit) — those each land as their own
  follow-on changes that consume the entity store.

## Decisions

### Decision 1: SQLite per tenant, not Postgres or Sheets

Per-tenant EC2 deployment makes SQLite the right backing store: a
single file on the instance, no DB server, no replication, backup
is `cp entities.db entities.db.bak`. Scale headroom at one practice
(~500 entities) is enormous. Postgres remains a one-PR migration if
the assumption ever changes — both speak SQL, the tools never see
the storage layer.

Sheets is rejected because the human editor (Piper/Heather) is being
replaced by Winston; the human-readable property that made Sheets
compelling is no longer load-bearing.

### Decision 2: Two tables plus an audit table; JSON columns absorb
everything else

```sql
CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  properties  TEXT NOT NULL,           -- JSON
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE relations (
  from_id     TEXT NOT NULL REFERENCES entities(id),
  type        TEXT NOT NULL,
  to_id       TEXT NOT NULL REFERENCES entities(id),
  properties  TEXT,                    -- JSON; may be null
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, type, to_id)
);

CREATE TABLE entity_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  trace_id    TEXT,
  actor       TEXT,
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,
  diff        TEXT NOT NULL
);
```

Indexes on `kind`, `name`, `json_extract(properties, '$.status')`,
relation `type` and `to_id`, audit `entity_id` and `ts`. JSON1
functions in SQLite make property queries fast enough; per-kind
schemas evolve at practice-specific cadences without column
migrations.

### Decision 3: ID convention is kind-prefix + slug (humans) or UUIDv4 (auto)

| Kind | ID format | Example |
|---|---|---|
| `team_member` | `t_<slug>` | `t_bethany`, `t_clare` |
| `client` | `c_<uuid-v4>` | `c_550e8400-e29b-41d4-a716-446655440000` |
| `contact` | `p_<uuid-v4>` | `p_a3f7c2b1-d8e9-4f5a-9c2d-1e3f4b5a6c7d` |
| `location` | `l_<slug>` | `l_office`, `l_mv`, `l_ais` |

Human-readable slugs for the small stable enumerations (team_member,
location) — operators reference those by name in route conditions and
templates. UUIDv4 for the auto-generated kinds — no collision concerns
at any scale, no design overhead defending a custom format. Migration
assigns IDs once; once assigned they never change.

Natural keys for dedup:
- `team_member`: lowercase email
- `client`: legal_name + date_of_birth
- `contact`: lowercase email; fallback to (lowercase name, phone)
- `location`: slug

`entity.upsert` uses natural keys to find an existing entity; if found,
updates; if not, creates with a new ID. Idempotent by construction.

### Decision 4: Schemas live in the workspace, not in Clawndom

JSON Schema files for each kind ship in the agent workspace (e.g.,
`winston-agency/workspaces/winston/schemas/`). Clawndom loads them at
boot via the workspace path, validates `entity.upsert` payloads
against the appropriate schema, and feeds them into the
`{{ entity_model }}` renderer.

Drives a clean separation: Clawndom is the substrate; kinds are data.
Adding `vendor` to Winston is "drop a schema file, restart, done" —
no Clawndom release.

### Decision 5: Resolver auto-discovers from schemas

The resolver does not need a separate config block. The schemas
themselves declare which properties hold emails (`"format": "email"`),
which hold Slack user IDs (by property name convention
`"slack_user_id"`), etc. The resolver scans all kinds at boot, builds
a property index keyed on identity-hint types, and looks up entities
by that index at inbound time.

Adding a kind that should be matchable by email is "include
`"format": "email"` on the appropriate schema property" — the
resolver picks it up automatically.

### Decision 6: Soft-delete via `status`, hard-delete reserved

Every kind's schema includes a `status` property with a kind-specific
enum. Offboarding is `entity.upsert(id=..., status='former',
ended_at=<date>)`; the entity persists, relations persist, audit log
captures the change. Queries that filter `status='active'` skip the
former entity.

`entity.purge(id, reason)` is the destructive escape hatch — gated
behind tool inclusion. Purge cascades to outgoing relations and
records the orphaned-incoming-relation list in the audit log.

### Decision 7: Resolver is internal; tools are external

Two access paths to the same store:

- **Internal** — `EntityResolver` reads SQLite directly at inbound
  time. Sub-millisecond. Used for actor resolution and route
  conditions.
- **External** — the five tools (find/get/upsert/relate/unrelate)
  backed by HTTP. Used by the agent during a run.

Both paths share a single `EntityStore` service class. The split is
transport, not storage.

### Decision 8: Migration is one-shot, big bang, per tenant

The migration script lives in the workspace
(`winston-agency/scripts/migrate-mcl-to-entities.py`). It reads the
v2 MCL restructure (already-deduplicated tabs: Clients, Contacts,
Therapists, Locations), filters to active clients per the operator's
confirmation YAML, and writes to the per-tenant SQLite file.
Idempotent on natural keys; re-running updates rather than
duplicates.

Script header notice: stop the agent's systemd service first. No
in-script locking — manual operator action, well-understood
discipline.

### Decision 9: Per-route `entities.kinds` declares scope; tools list declares operations

```yaml
- name: handle-cancellation
  entities:
    kinds: [client, contact, team_member]   # rows of the access matrix
  tools:
    - module.python: agency_tools.entity.find
    - module.python: agency_tools.entity.get
    # no upsert/relate → read-only flow (columns of the access matrix)
```

The two axes are orthogonal: `entities.kinds` controls which entities
Winston can touch; `tools:` controls which operations he can perform.
Read-only is "include find/get, omit upsert/relate" — no separate
`read:`/`write:` config needed.

If Winston calls a tool with a `kind` not in `entities.kinds`,
Clawndom rejects with `Kind 'X' not declared for this route`.
Mirrors the existing tool-list least-privilege pattern at the
data-surface layer.

### Decision 10: `{{ entity_model }}` is generated per fire, not cached

When a route declares `entities.kinds`, Clawndom synthesizes a
markdown handbook from the workspace schemas + `relations.json`,
filtered to the kinds in scope. The template author injects it via
`{{ entity_model }}`.

Generation cost: stat + read ~4 small files + interpolate strings,
~10ms cold. Per-fire cost is negligible next to the LLM call. No
caching, no invalidation logic — just regenerate.

### Decision 11: Interaction log keys on entity ID

The interaction log writes one record per chat-style turn with
`actor_id` as the entity ID. Strangers get `actor_id: null` with a
separate `actor_email` field; their entries land in a stranger-keyed
bucket (`interactions:<agent>:stranger:<email>`). Post-promotion
backfill is not done — known acceptable annoyance.

### Decision 12: ISO-8601 dates

Every property declared as a date (`"format": "date"` in the schema)
uses ISO-8601 (`YYYY-MM-DD`). The migration script normalizes v2's
text dates (`"2/19/2025"`, `"2026-05-07"`) on the way in. The schema
validator enforces format on subsequent writes.

## Open Questions

These are the items that genuinely remain after the substrate/workspace
split and the property audit:

1. **Conflict policy for concurrent upserts.** SQLite WAL serializes
   writes, so the write path is safe. Default value semantics:
   last-writer-wins (the upsert's provided properties replace the
   existing properties JSON wholesale). Acceptable for v1; revisit if
   per-field merge is ever needed.

2. **Relation history on `unrelate`.** The audit log captures the
   unrelate; the relations table forgets. "Who was Carter's therapist
   six months ago" requires audit traversal, not a relation query.
   Known limitation; acceptable.

3. **`entity.find` relation-traversal queries.** "Find all clients
   where therapist = t_bethany" is a relation query. Three options:
   (a) overload `find` to accept relation filters, (b) add an
   `entity.related(id, type)` tool, (c) require `get(id,
   expand_relations=true)` then in-prompt filtering. Probably (b)
   when first asked for; defer.

## Capability spec stubs

Three new capability specs land with this change:

- `openspec/specs/entity-store/spec.md` — entities/relations shapes,
  five tool contracts, gated purge, audit log, workspace-side schema
  loading, ISO-8601 dates, per-route `entities.kinds`, `{{
  entity_model }}` rendering.

- `openspec/specs/actor-resolution/spec.md` — `Actor` discriminated
  union, schema-auto-discovered resolver chain, route-condition
  contract on `actor.*`, framework-internal access pattern.

- `openspec/specs/cross-surface-interactions/spec.md` — interaction-log
  record shape, Redis sorted-set key convention, per-route
  `interactions: {topN}` opt-in, strangers-bucket fallback.
