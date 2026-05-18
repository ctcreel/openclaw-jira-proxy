## Purpose

Defines the per-tenant entity store: a typed, queryable substrate for an
agent's proper nouns plus the typed relations between them. Clawndom
ships the substrate (storage, tools, HTTP, audit, resolver, renderer);
each agent's workspace declares the kinds and relations via JSON Schema
files. The agent reads and writes through five HTTP-backed tools (plus
a gated sixth, `purge`); the framework reads directly via an internal
resolver for actor resolution and via the per-fire `{{ entity_model }}`
renderer.

## Requirements

### Requirement: SQLite-backed Per-Tenant Store

The entity store MUST be a single SQLite file per clawndom instance.
The file path MUST be configurable (default
`/home/ubuntu/.clawndom-<agent>/entities.db`). Schema migrations MUST
run on startup and MUST be idempotent. WAL mode MUST be enabled so
concurrent reads do not block writes.

#### Scenario: Fresh Boot Creates Schema

- **GIVEN** A clawndom instance starts with no existing `entities.db`
- **WHEN** Startup migration runs
- **THEN** The file MUST be created with `entities`, `relations`, and
  `entity_audit` tables plus the documented indexes
- **AND** The file MUST be in WAL mode

#### Scenario: Re-Boot Against Existing DB

- **GIVEN** A clawndom instance starts with a populated `entities.db`
- **WHEN** Startup migration runs
- **THEN** No tables MUST be re-created and no data MUST be lost
- **AND** Missing indexes (if any) MUST be added without rebuilding
  existing tables

### Requirement: Entity Shape and ID Convention

Every entity MUST have an `id`, `kind`, `name`, `properties` (JSON
object), `created_at`, and `updated_at`. IDs MUST follow a
kind-prefix convention:

- `team_member`: `t_<slug>` (operator-supplied slug, human-stable)
- `client`: `c_<uuid-v4>` (generated when not supplied)
- `contact`: `p_<uuid-v4>` (generated when not supplied)
- `location`: `l_<slug>` (operator-supplied slug, human-stable)

Team members and locations keep human-readable slugs because they are
the small stable enumerations that humans (operators and templates)
actually reference by ID. Clients and contacts are auto-generated at
intake; UUIDs avoid the design overhead of defending a custom format
and remove any collision concerns at any scale (including future
cross-tenant federation).

IDs MUST NOT change after creation, even when the entity is renamed.

#### Scenario: Auto-Generated Client ID

- **GIVEN** `entity.upsert(kind='client', properties={legal_name:
  'Ari Goolsby', dob: '2018-04-12', ...})` with no supplied ID
- **WHEN** No existing entity matches the natural key (legal_name +
  dob)
- **THEN** A new ID MUST be generated matching `^c_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (kind-prefix + UUIDv4)
- **AND** The returned record MUST carry that ID

#### Scenario: Operator-Supplied Team Member Slug

- **GIVEN** `entity.upsert(kind='team_member', id='t_bethany',
  properties={...})`
- **WHEN** No existing team_member has that ID
- **THEN** The entity MUST be created with ID `t_bethany` exactly

### Requirement: Natural-Key Dedup on Upsert

`entity.upsert` MUST be idempotent on the kind-specific natural key:

| Kind | Natural key |
|---|---|
| `team_member` | lowercase email |
| `client` | legal_name + dob |
| `contact` | lowercase email; fallback to (lowercase name, phone) when no email |
| `location` | slug |

When a natural-key match exists, `upsert` MUST update the existing
entity in place (preserving `created_at` and `id`, updating
`updated_at` and `properties`). When no match exists and no `id` is
supplied, `upsert` MUST create a new entity.

#### Scenario: Re-Upsert Same Team Member

- **GIVEN** A team_member with email `bethany@talkatlanta.info`
  already exists as `t_bethany`
- **WHEN** A second upsert is called with the same email but no ID
- **THEN** The existing `t_bethany` MUST be updated, not duplicated
- **AND** The returned ID MUST be `t_bethany`

#### Scenario: Last-Writer-Wins Property Replacement

- **GIVEN** An existing entity with `properties: { a: 1, b: 2 }`
- **WHEN** An upsert is called with `properties: { a: 3 }`
- **THEN** The stored properties MUST be `{ a: 3 }` (not `{ a: 3, b:
  2 }`); the caller is responsible for sending the full desired state

### Requirement: Workspace-Declared Schemas

Each entity kind MAY have a JSON Schema file in the agent's workspace
at `<workspace>/schemas/<kind>.schema.json` (e.g.,
`winston-agency/workspaces/winston/schemas/client.schema.json`).
Clawndom loads schemas at boot from the workspace path. When a schema
exists, `entity.upsert` MUST validate the `properties` blob against
that schema before write. Validation failures MUST be reported with
the failing property path and the constraint that failed.

When no schema exists for a kind, `entity.upsert` MUST accept any
JSON object as `properties` (schemaless fallback). This lets the
agent experiment with new kinds before committing to a schema.

Date-typed properties (declared in the schema as `"format": "date"`)
MUST be ISO-8601 (`YYYY-MM-DD`). Email-typed properties (declared as
`"format": "email"`) MUST pass standard email validation. The
validator MUST reject writes that violate these format constraints.

#### Scenario: Workspace Schema Loaded at Boot

- **GIVEN** A workspace ships `schemas/client.schema.json`
- **WHEN** Clawndom starts the agent
- **THEN** The schema MUST be loaded and available to the validator
- **AND** `entity.upsert(kind='client', ...)` MUST validate against it

#### Scenario: ISO-8601 Date Enforced

- **GIVEN** `client.schema.json` declares `started_at` with
  `"format": "date"`
- **WHEN** `entity.upsert(kind='client', properties={started_at:
  '2/19/2025'})` is called (US-format text)
- **THEN** The call MUST fail with a format-violation error

#### Scenario: Missing Required Property

- **GIVEN** `client.schema.json` requires `legal_name`, `dob`,
  `status`
- **WHEN** `entity.upsert(kind='client', properties={dob: ...,
  status: 'active'})` (no `legal_name`)
- **THEN** The call MUST fail with an error naming the missing
  property
- **AND** No row MUST be inserted

#### Scenario: Schemaless Kind Accepted

- **GIVEN** No schema file exists for kind `vendor`
- **WHEN** `entity.upsert(kind='vendor', properties={name: 'Acme',
  whatever: 'value'})`
- **THEN** The entity MUST be created without validation errors

### Requirement: Typed Relations

The store MUST support typed relations between entities via the
`relations` table. A relation MUST have `from_id`, `type`, `to_id`,
optional `properties`, and `created_at`. The composite primary key
(`from_id`, `type`, `to_id`) MUST prevent duplicate relations of
the same type between the same two entities.

#### Scenario: Establish has_therapist Relation

- **GIVEN** A client `c_abc123` and a team_member `t_bethany` both
  exist
- **WHEN** `entity.relate(from_id='c_abc123', type='has_therapist',
  to_id='t_bethany')` is called
- **THEN** A relation row MUST be inserted
- **AND** A second identical call MUST be a no-op (idempotent)

#### Scenario: Relation to Non-Existent Entity Rejected

- **GIVEN** No entity exists with ID `c_nope`
- **WHEN** `entity.relate(from_id='c_nope', type='has_therapist',
  to_id='t_bethany')` is called
- **THEN** The call MUST fail with a foreign-key violation
- **AND** No relation row MUST be inserted

### Requirement: Soft Delete via Status, Purge Reserved

Offboarding MUST be performed by updating the `status` property
(e.g., `status='former'`) via `entity.upsert`. The entity row, its
outgoing relations, and its audit history MUST be preserved.

Hard delete (`entity.purge(id, reason)`) MUST cascade to outgoing
`relations` rows but MUST NOT cascade to incoming relations. The
list of orphaned incoming relations MUST be recorded in the audit
log. Purge MUST require a non-empty `reason` string.

#### Scenario: Soft-Delete via Status

- **GIVEN** A client `c_abc123` with `status='active'`
- **WHEN** `entity.upsert(id='c_abc123', properties={status:
  'former', ended_at: '2026-05-30', ...})`
- **THEN** The entity row MUST still exist
- **AND** Outgoing `has_therapist` and `has_parent` relations MUST
  still exist
- **AND** A `find(kind='client', status='active')` query MUST NOT
  return this entity

#### Scenario: Purge Cascade

- **GIVEN** A duplicate-test contact `p_test123` with one outgoing
  relation (`is_contact_for c_abc`) and one incoming relation
  (`has_parent` from `c_abc`)
- **WHEN** `entity.purge(id='p_test123', reason='test fixture')` is
  called
- **THEN** The entity row MUST be deleted
- **AND** The outgoing `is_contact_for` relation MUST be deleted
- **AND** The incoming `has_parent` relation MUST remain
- **AND** An audit record MUST capture the orphaned-incoming-
  relation list and the reason

### Requirement: Find Matches on Alias

`entity.find` MUST match against the `aliases` property in addition
to `name`. Aliases are a clinically-meaningful PHI-protection device
— therapists use codes like "AIS AH" (Alan Hu at AIS) in shared
calendars and conversations to avoid surfacing identifying detail
publicly. When an inbound event or query references a client by
alias rather than legal name, the resolver MUST surface the same
entity.

The `aliases` property is an array of strings; a client may have
zero or more aliases. Aliases SHOULD be unique within a tenant but
the store does not enforce uniqueness (collisions are a data
quality issue, not a correctness issue).

#### Scenario: Find by Alias

- **GIVEN** A client `c_<uuid>` with `name: 'Alan Hu'` and
  `aliases: ['AIS AH']`
- **WHEN** `entity.find(kind='client', q='AIS AH')` is called
- **THEN** The result MUST include the Alan Hu entity

#### Scenario: Multiple Aliases

- **GIVEN** A client with `aliases: ['AIS AH', 'AH-K2']`
- **WHEN** `entity.find` is called with either alias
- **THEN** The same entity MUST be returned in both cases

### Requirement: Audit Log on Every Write

Every successful create, update, relate, unrelate, and purge MUST
insert one row into `entity_audit` with `ts`, `trace_id`, `actor`
(e.g., `tool:entity.upsert`, `handler:intake`, `migration:initial`),
`entity_id`, `op`, and a JSON `diff` of the before/after state. A
failure to write the audit row MUST roll back the primary write.

#### Scenario: Audit Captures Diff

- **GIVEN** A team_member `t_clare` with `properties: {status:
  'active', ...}`
- **WHEN** An upsert changes `status` to `on_leave`
- **THEN** The audit row's `diff` MUST contain `before.status:
  'active'` and `after.status: 'on_leave'`
- **AND** The `actor` field MUST be `tool:entity.upsert`

### Requirement: HTTP Endpoints

The store MUST expose HTTP endpoints scoped per agent, bearer-token
gated:

- `GET /api/agents/:agent/entities` (list/search with kind, name
  substring, status, JSON-path property filters)
- `GET /api/agents/:agent/entities/:id` (fetch by ID, optional
  `?expand=relations`)
- `POST /api/agents/:agent/entities` (upsert)
- `POST /api/agents/:agent/entities/:id/relations` (relate)
- `DELETE /api/agents/:agent/entities/:id/relations/:type/:to`
  (unrelate)
- `GET /api/agents/:agent/entities/audit?since=...` (audit log
  tail)

Auth failures MUST return 401; invalid request bodies MUST return
400 with the same RFC 7807-style shape as existing controllers.

#### Scenario: Unauthorized Read

- **GIVEN** No bearer token in the request
- **WHEN** `GET /api/agents/winston/entities`
- **THEN** The response MUST be 401

#### Scenario: Invalid Upsert Payload

- **GIVEN** A POST with no `kind` field
- **WHEN** The controller validates
- **THEN** The response MUST be 400 naming the missing field
- **AND** No row MUST be inserted

### Requirement: Per-Route `entities.kinds` Declaration

Routes in `clawndom.yaml` that use the entity tools MUST declare an
`entities.kinds` list naming the kinds in scope for that route.
Clawndom MUST reject `entity.*` tool calls that reference a kind not
in the route's `entities.kinds`, with an error like `Kind 'X' not
declared for this route`.

The `entities.kinds` list also drives the `{{ entity_model }}`
template-context variable: only the listed kinds and the relations
connecting them are rendered in the handbook for that route.

Routes without `entities.kinds` MUST NOT have any entity tools in
their MCP bundle, MUST NOT pay the resolver cost, and MUST NOT
receive a `{{ entity_model }}` variable.

#### Scenario: Route Without `entities.kinds`

- **GIVEN** A scheduled rule with no `entities` block
- **WHEN** The rule fires
- **THEN** The event context MUST NOT include an `actor` field
- **AND** The resolver MUST NOT have been called
- **AND** `{{ entity_model }}` MUST NOT be in the template context

#### Scenario: Out-of-Scope Kind Rejected

- **GIVEN** A route with `entities.kinds: [client, contact]`
- **WHEN** The agent calls `entity.upsert(kind='team_member', ...)`
- **THEN** The call MUST fail with `Kind 'team_member' not declared
  for this route`
- **AND** No row MUST be inserted

### Requirement: `{{ entity_model }}` Renderer

When a route declares `entities.kinds`, Clawndom MUST synthesize a
markdown handbook describing the in-scope kinds (per-kind properties
and descriptions from the schemas) and the relations between them
(from `relations.json`). The handbook MUST be exposed to the
template renderer as the `entity_model` variable.

The handbook MUST be regenerated per fire. Generation cost is
dominated by reading the workspace schema files; at the small file
sizes typical of these schemas, this is microseconds and need not
be cached.

#### Scenario: Trimmed Handbook for Read-Only Route

- **GIVEN** A route with `entities.kinds: [client, contact]` and
  tools `[entity.find, entity.get]` only
- **WHEN** The route matches and the template renders
- **THEN** `{{ entity_model }}` MUST describe only `client` and
  `contact`
- **AND** Relations whose `from` or `to` is `team_member` or
  `location` MUST NOT appear

#### Scenario: Schema Update Reflected Next Fire

- **GIVEN** A workspace ships `schemas/client.schema.json` describing
  property `paperwork_status`
- **AND** A subsequent workspace deploy updates the schema to
  remove `paperwork_status`
- **WHEN** A route fires after the workspace reload
- **THEN** `{{ entity_model }}` MUST reflect the new schema (no
  `paperwork_status` field shown)
