## Context

Winston serves a small speech-therapy practice. Today the practice's
proper-noun data is split between:

1. **The Master Client Log (MCL)** — a hand-maintained Google Sheet
   originally created by Piper, the office manager. Two tabs (Active,
   Inactive) with slightly different schemas. Free-text foreign keys
   ("Therapist: Heather Hamilton"), inconsistent date formats, ~20
   nameless contact entries, multi-kid families denormalized so each
   child duplicates parent contact info, no constraint enforcement.
2. **The Therapists/Staff sheet** — a separate tab listing team
   members with credentials, NPIs, malpractice info. Mostly stable.
3. **Heather's inbox + calendar + Drive folders** — the actual primary
   storage of "what's going on" with each client.

This works for Piper because she's a human with judgment; she
disambiguates "Bethany" by context, knows that Camilla and Chapman
share parents, and remembers when paperwork is owed. Winston cannot
operate that way. He needs *typed*, *related*, *queryable* data with
stable identifiers across surfaces.

The previous design pass (`identity-and-interactions`) introduced three
separate features for this: TeamRegistry (declarative YAML), ClientLookup
(a Sheets-backed read-only port), and InteractionLog (Redis turn log).
That decomposition was sound when the only consumers were the identity
resolver and the cross-surface continuity case. It does not scale to the
full vision: Heather replaces Piper with Winston, and Winston handles
intake, scheduling, offboarding, onboarding, and audit. Every one of
those workflows reads and writes the same shape of data — typed
entities and typed relations between them. Three abstractions collapse
into one.

This change introduces that one abstraction (the entity store) and
rebuilds identity resolution and the interaction log on top of it.
Downstream workflows (intake, scheduling, offboarding, therapist
onboarding, nightly audit) each land as their own follow-on change
that uses this substrate.

## Goals / Non-Goals

**Goals:**

- A single typed, queryable substrate for the practice's proper nouns:
  clients, contacts, team members, locations. Same shape works for
  future kinds (vendors, documents, calendar events) without code
  changes — just a new JSON Schema file.
- Stable IDs across surfaces and over time. An entity created during
  intake has the same ID when referenced in scheduling, audit, billing,
  and offboarding.
- Schema validation per kind enforced at write time. JSON Schema files
  define required and optional properties; `entity.upsert` rejects
  invalid input. Sheets-style "anything-goes typing" goes away.
- Soft-delete by default. A status property changes; the entity
  persists; history is preserved; hard-delete is a separate, audited
  operation reserved for cleanup of test/duplicate entities.
- Tight coupling with the identity resolver and the interaction log.
  The resolver reads entities at inbound time; the interaction log
  keys on entity IDs at end-of-run. One substrate, two consumers.
- Per-tenant scoping. Each clawndom instance owns its own SQLite file.
  No cross-tenant identity. Matches the per-tenant EC2 deployment
  model.
- Big-bang migration. Pre-production today; no operational SLA to
  honor; new store replaces the Sheets in one cutover per tenant. No
  shadow-write period, no consistency reconciliation, no rollback plan
  beyond "restore the SQLite file from backup."

**Non-Goals:**

- A graph database. Two SQL tables (`entities` + `relations`) cover
  every query at this scale (~100 entities of each kind per practice,
  ~100 practices). Neo4j / Stardog / TerminusDB are overkill.
- A human-facing UI for the entity store. Heather doesn't browse the
  knowledge base; she talks to Winston, and Winston reads and writes
  the store on her behalf. Operator inspection happens via a JSON
  endpoint plus `curl` when something needs debugging.
- Cross-workspace federation. Patch's contributors and Winston's
  clients are different domains. The entity stores are per-tenant; if
  a future use case needs cross-tenant identity (it doesn't today),
  that's its own change.
- Full RDF or ontology. Entity kinds are domain-specific; the schema
  files capture practice-specific structure. No attempt to be
  schema.org-compatible or to interoperate with other knowledge bases.
- Generic CRUD UI generation. The four tools are agent-facing because
  Winston needs them. Heather is not a tool user.
- A migration tool for the workflows themselves. Each downstream
  workflow (intake, scheduling, offboarding, onboarding, audit) lands
  as its own proposal that uses the entity store. This change only
  ships the substrate plus the rebuild of `actor-resolution` and
  `cross-surface-interactions` on top.

## Decisions

### Decision 1: SQLite per tenant, not Postgres or Sheets

SQLite is chosen for three reasons:

1. **Per-tenant deployment alignment.** Each Winston runs on its own
   EC2 instance. SQLite is a file on that instance. No DB server to
   provision, no network port to open, no replication to configure.
   Backup is `cp entities.db entities.db.bak`. Restore is the reverse.
2. **Scale headroom.** At ~100 active clients × ~200 contacts and
   team and locations per practice × 100 practices = 30K entities
   total across the fleet. Each tenant's local file is ~500 entities.
   SQLite handles millions of rows on a t3.medium without breaking a
   sweat.
3. **Migration to Postgres remains trivial** if scale or multi-tenant
   needs ever change. Both speak SQL; the schema is portable; the
   four agent-facing tools never see the storage layer. The agent's
   mental model and the tool surface are storage-agnostic by design.

Sheets is rejected because the editor (Heather/Piper) is being
replaced by Winston; the human-readable property that made Sheets
compelling is no longer load-bearing. Postgres is rejected at v1 only
because it costs more to operate than SQLite for no current benefit;
if a multi-process write workload appears, this becomes a one-PR
migration.

### Decision 2: Two tables, JSON columns absorb everything else

The shape is:

```sql
CREATE TABLE entities (
  id          TEXT PRIMARY KEY,        -- 't_bethany', 'c_xyz123', etc.
  kind        TEXT NOT NULL,           -- 'team_member' | 'client' | 'contact' | 'location'
  name        TEXT NOT NULL,           -- display name; not a key
  properties  TEXT NOT NULL,           -- JSON
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE relations (
  from_id     TEXT NOT NULL REFERENCES entities(id),
  type        TEXT NOT NULL,           -- 'has_therapist', 'has_parent', ...
  to_id       TEXT NOT NULL REFERENCES entities(id),
  properties  TEXT,                    -- JSON; may be null
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, type, to_id)
);

CREATE INDEX idx_entities_kind         ON entities(kind);
CREATE INDEX idx_entities_name         ON entities(name COLLATE NOCASE);
CREATE INDEX idx_entities_status       ON entities(json_extract(properties, '$.status'));
CREATE INDEX idx_relations_type        ON relations(type);
CREATE INDEX idx_relations_to          ON relations(to_id);

CREATE TABLE entity_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  trace_id    TEXT,
  actor       TEXT,                    -- 'tool:entity.upsert' / 'handler:intake' / 'migration'
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,           -- 'create' | 'update' | 'relate' | 'unrelate' | 'purge'
  diff        TEXT NOT NULL            -- JSON {before: {...}, after: {...}}
);
CREATE INDEX idx_audit_entity   ON entity_audit(entity_id);
CREATE INDEX idx_audit_ts       ON entity_audit(ts);
```

JSON columns absorb everything that isn't a key, index, or audit
field. The reason: per-kind schemas evolve at practice-specific
cadences (a practice adds a "preferred_pronouns" property on
contacts), and schema-migrating SQLite at every property addition is
overhead with no benefit. JSON1 functions in SQLite make property
queries fast enough (the `json_extract`-backed index above
demonstrates this).

### Decision 3: ID convention is kind-prefix + slug

| Kind | ID format | Example |
|---|---|---|
| `team_member` | `t_<slug>` | `t_bethany`, `t_clare` |
| `client` | `c_<8char base32>` | `c_pwke8x7v` |
| `contact` | `p_<8char base32>` | `p_d9q3kfp2` |
| `location` | `loc_<slug>` | `loc_office`, `loc_mv`, `loc_ais` |

Slugs are human-readable when small and stable (team, locations);
random base32 when generated programmatically (clients, contacts).
The prefix-on-ID convention lets a human reader eyeball an ID and
know its kind without a lookup. Migration assigns IDs once; once
assigned they never change, even on rename.

Natural keys for dedup:
- `team_member`: lowercase email
- `client`: legal name + DOB (the only natural key, since name
  collisions exist; DOB makes it unique enough)
- `contact`: lowercase email (primary); falls back to (lowercase
  name, phone) when no email is present
- `location`: slug (the location name)

`entity.upsert` uses natural keys to find an existing entity; if
found, updates; if not, creates with a new ID. Idempotent by
construction.

### Decision 4: Schema validation per kind, schemaless fallback

Each kind has a JSON Schema file:

```
clawndom/src/services/entities/schemas/
  client.schema.json
  contact.schema.json
  team_member.schema.json
  location.schema.json
```

Properties documented in each. Required + optional + types + format
constraints (e.g., email regex). `entity.upsert` validates the
`properties` blob against the kind's schema before write; rejects on
violation with a clear error message naming the failed property.

New kinds without a schema file fall through to schemaless validation
(any JSON object accepted). This lets the agent experiment with new
kinds before we commit to a schema. When a kind stabilizes, a schema
file is added.

### Decision 5: Soft-delete via `status`, hard-delete reserved

Every kind's schema includes a `status` property with a kind-specific
enum (e.g., for `client`: `active | former | waitlist | discharged`;
for `team_member`: `active | departed | on_leave`; for `contact`:
`active | inactive` — relevant when a parent's role ends).

The default offboarding flow is `entity.upsert(id=..., status='former',
ended_at=<date>)`. The entity persists; relations persist; the audit
log captures the status change. Queries that filter on
`status='active'` skip the now-former entity.

Hard-delete is a separate tool, `entity.purge(id, reason)`. Used only
for cleanup of test or duplicate entities. Purge emits an audit
record naming the reason and the purger (which agent run, which
trace_id). Purge cascades to outgoing relations (the relations rows
are also deleted), but does NOT cascade to incoming relations — the
audit log records the orphaned-incoming-relation list so it can be
inspected after the fact.

### Decision 6: Resolver is internal; tools are external

Two access paths to the same store:

**Internal access** — `EntityResolver` service in clawndom, called by
`worker.service.ts` at inbound time. Reads the SQLite file directly,
no HTTP, no MCP roundtrip. Sub-millisecond cost on the hot path. Used
only for actor resolution and route condition evaluation.

**External access** — the four SPE-2078 tools (`entity.find`,
`entity.get`, `entity.upsert`, `entity.relate`) backed by Clawndom
HTTP endpoints. Used by the agent during a run. HTTP adds latency (a
few ms) but isolates the agent process from direct DB access. Mirrors
how `dispatch_task`, `scheduled_tasks.*`, and the memory tools work.

The two access paths share a single underlying service class
(`EntityStore`) so all reads and writes go through the same code
path. The split is *transport*, not *storage*; the resolver doesn't
have a faster shortcut, it just doesn't pay the HTTP serialization
cost.

### Decision 7: Migration is one-shot, big bang, per tenant

The migration script reads:

1. The current MCL Google Sheet (Active + Inactive tabs)
2. The Therapists/Staff sheet (separate tab in the same spreadsheet)
3. Optional operator hints (Slack user-ID overrides, etc.)

It writes to the per-tenant SQLite file. Idempotent (re-runnable): if
an entity with a matching natural key already exists, the script
updates rather than creates.

Runs at tenant provisioning. Old Google Sheets stay in place as a
historical artifact; Winston stops reading from them after the
cutover. If something goes wrong, the rollback is "restore the SQLite
file from backup and revert Winston's clawndom.yaml to the previous
version" — no data loss, since Winston wrote to the SQLite file and
not the Sheets during the failed window.

The Sheets-to-entities migration uses the v2 restructure shape built
earlier (`master_client_log_v2.xlsx`) as the canonical pre-import
form. That shape already handles the multi-kid family case
(deduplicated Contacts table, proper parent_emails per contact,
adult-self-clients marked with `role: 'self'`, etc.).

### Decision 8: Per-route opt-in, not global

A route declares whether it needs entity tools and the resolver:

```yaml
routing:
  slack-winston:
    rules:
      - name: chat
        entities: true       # actor resolution runs; entity.* tools available
        interactions: { topN: 5 }
        tools:
          - module.python: agency_tools.entity.find
          - module.python: agency_tools.entity.upsert
          - module.python: agency_tools.entity.relate
          # ...other tools
```

Routes without `entities: true` don't pay the resolver cost and don't
get the entity tools in their MCP bundle. The morning-briefing
scheduled run, for example, doesn't need entity tools every morning;
it might call `entity.find` once to look up Heather, but it doesn't
need write access.

### Decision 9: Interaction log keys on entity ID, not raw email

The interaction log (preserved from the earlier proposal) writes one
record per chat-style turn with `actor_id` as the entity ID. For
strangers (resolver miss), `actor_id` is `null` and a separate
`actor_email` field carries the raw email; the entry lands in a
stranger-keyed bucket (`interactions:<agent>:stranger:<email>`). When
a stranger later becomes a known entity (via `entity.upsert`), their
old stranger-keyed entries don't automatically migrate to the
entity's new ID; this is a known small-cost annoyance that doesn't
bite enough to fix.

## Open Questions

1. **JSON Schema or zod for kind schemas?** Both work. JSON Schema is
   language-agnostic (the Python entity tools can validate too); zod
   is more idiomatic for the TypeScript side. Probably JSON Schema
   for portability.

2. **What's the conflict policy for upsert under concurrent writes?**
   SQLite serializes writes via WAL+lock, so the *write* path is
   safe. The *value* path — what if two agents update the same entity
   in overlapping windows? Default: last-writer-wins (the upsert's
   provided properties replace the entire properties JSON). Tighter
   policy (per-field merge, optimistic concurrency control) is
   possible but probably overkill.

3. **Should `entity.find` support relation-traversal queries?** E.g.,
   "find all clients where therapist = t_bethany." That's a relation
   query, not an entity query. Options: (a) overload `entity.find` to
   accept relation filters, (b) add a separate `entity.related(id,
   type)` tool, (c) keep `find` pure-entity and require the agent to
   call `entity.get(id, expand_relations=true)` then filter in-prompt.
   Probably (b) — keeps each tool single-purpose.

4. **How does soft-deleted-entity cleanup work?** Soft-delete
   preserves history forever. Eventually that's a lot of formers (10
   years of speech-therapy clients × 100 practices). At what point
   does it matter? Probably never in practice. The audit log table is
   what grows; even that is bounded by physical disk on each tenant's
   t3.medium.

5. **Should we ship a "rename / merge" tool for handling typo
   duplicates that slipped past the deduper?** E.g., `Aria Sangha`
   and `Aria Sangham` end up as two entities; an operator says
   "those are the same person, merge them." `entity.merge(from, to)`
   would: rewrite all incoming relations to point at `to`, copy
   missing properties from `from` to `to`, soft-delete `from`. Worth
   building when the first manual merge is needed; defer for now.

6. **Does the Apps Script intake relay write directly to entities, or
   does it dispatch a task that Winston handles?** Both work; the
   former is faster (no agent latency), the latter is more
   Winston-native (he writes the records in his own voice with his
   own tools). The intake-flow proposal that builds on this change
   picks the answer. For *this* change, the entity tools work either
   way.

7. **What happens to Heather's MCL during the cutover window?** The
   migration reads the Sheet once; from that moment until Winston is
   live with the new store, any edits Heather makes to the Sheet are
   lost. Mitigation: do the migration at a low-activity time (evening
   or weekend) and tell Heather not to touch the MCL for an hour.
   Real-world Heather edits the MCL roughly never (per the "I don't
   want to be in the MCL" framing in conversation), so this is a thin
   risk.

## Capability spec stubs

Three new capability specs land with this change:

- `openspec/specs/entity-store/spec.md` — defines the entity +
  relation shapes, the four tool contracts, the audit log, the
  per-kind schema files, the upsert semantics (natural-key dedup,
  last-writer-wins), and the soft-delete-vs-purge distinction.

- `openspec/specs/actor-resolution/spec.md` — defines the `Actor`
  discriminated union, the resolver chain (slack-user-id → email →
  oidc-email → stranger), the route-condition contract on `actor.*`,
  and the framework-internal access pattern (no agent in the loop for
  resolver reads).

- `openspec/specs/cross-surface-interactions/spec.md` — defines the
  interaction-log record shape, the Redis sorted-set key convention,
  the per-route `interactions: {topN}` opt-in, and the
  strangers-bucket fallback.
