## Purpose

Defines how Clawndom resolves the sender of an inbound event to a
canonical `Actor` discriminated union by reading the entity store.
The resolver is framework-internal — the agent does not call it —
so resolution costs are paid on the hot path and route conditions
can predicate on `actor.*` fields.

## Requirements

### Requirement: Actor Discriminated Union

Every inbound event on a route with `entities: true` MUST carry an
`actor` value with one of four kinds:

- `team_member`: `{ kind: 'team_member', id, name, role, permissions,
  emails }`
- `client`: `{ kind: 'client', id, name }`
- `contact`: `{ kind: 'contact', id, name, role, client_ids }`
- `stranger`: `{ kind: 'stranger', id: null, email }`

The `id` field MUST be the entity ID from the store for the first
three kinds and MUST be `null` for stranger.

#### Scenario: Team Member Resolved

- **GIVEN** A team_member entity `t_heather` with email
  `heather@talkatlanta.info`
- **WHEN** An event arrives with `identityHints: { email:
  'heather@talkatlanta.info' }`
- **THEN** The resolved actor MUST be `{ kind: 'team_member', id:
  't_heather', ... }`

#### Scenario: Stranger Fallback

- **GIVEN** No entity matches any provided hint
- **WHEN** Resolution runs
- **THEN** The resolved actor MUST be `{ kind: 'stranger', id: null,
  email: <raw> }`

### Requirement: Resolver Is a Strategy Pattern

Resolution MUST be implemented as a strategy pattern keyed on
identity-hint type. Each strategy MUST declare:
- `hintName`: the identity-hint field this strategy consumes
  (`email`, `slack_user_id`, `phone`, etc.)
- `propertyFormat`: the JSON Schema `"format"` value (or property
  name convention) that signals "an entity property of this type
  participates in resolution"
- `extractHint(event)`: extracts the hint value from an inbound
  event payload
- `normalize(raw)`: per-strategy value normalization
  (lowercase emails, strip phone formatting, etc.)

At boot, the orchestrator MUST cross-reference each strategy's
`propertyFormat` against all workspace schemas, building a map
of which kinds participate per hint type. At inbound time,
strategies MUST run in priority order (slack_user_id → email →
phone → ...), with first hit winning.

Adding support for a new hint type (e.g., phone, OIDC email) MUST
be achievable by registering a new strategy plus marking the
appropriate schema property with the matching `"format"` value or
property-name convention. No orchestrator changes required.

The resolver MUST NOT consult any source outside the entity store.

### Requirement: Actor IS the Resolved Entity

The returned `Actor` MUST be the resolved entity itself — its
`id`, `kind`, `name`, and its own properties from the schema. The
resolver MUST NOT walk outgoing or incoming relations to enrich
the actor.

Route conditions predicate on the actor's own fields (e.g.,
`actor.role`, `actor.email`). Looking up related entities (e.g.,
"which clients does this contact represent") MUST be done by the
agent during the run via tool calls, not by the resolver.

#### Scenario: Team Member Actor Carries Schema Properties

- **GIVEN** A team_member entity `t_heather` with properties
  `{ email, role, employment_type, slack_user_id, status }`
- **WHEN** Resolution returns this entity as the actor
- **THEN** The actor MUST be
  `{ kind: 'team_member', id: 't_heather', name: 'Heather Hamilton',
     email: '...', role: '...', employment_type: '...',
     slack_user_id: '...', status: 'active' }`
- **AND** The actor MUST NOT carry related-entity IDs or
  collections

#### Scenario: Route Condition on Actor Property

- **GIVEN** A route with condition `{ equals: { field: actor.role,
  value: 'owner' } }`
- **AND** A team_member entity with `role: 'owner'` resolves
- **THEN** The route condition MUST match

#### Scenario: Slack Hint Takes Precedence

- **GIVEN** `identityHints: { slack_user_id: 'U123', email:
  'parent@example.com' }`
- **AND** team_member `t_alisha` has `slack_user_id: 'U123'`
- **AND** contact `p_xyz` has `email: 'parent@example.com'`
- **WHEN** Resolution runs
- **THEN** The resolved actor MUST be `t_alisha` (team_member)
- **AND** The contact MUST NOT be consulted

#### Scenario: Case-Insensitive Email Match

- **GIVEN** A team_member with `emails: ['heather@talkatlanta.info']`
- **WHEN** Hints contain `email: 'HEATHER@TalkAtlanta.info'`
- **THEN** The resolver MUST match and return that team_member

### Requirement: Internal-Only Access

The resolver MUST be framework code, not an agent-facing tool. The
agent MUST NOT have a `resolve_actor` or equivalent tool. Resolution
runs once per inbound event, before route matching, and MUST NOT
require an agent-loop turn.

#### Scenario: No Agent Tool

- **GIVEN** Any agent's tool bundle on any route
- **WHEN** The bundle is inspected
- **THEN** No tool named `actor.resolve`, `identity.lookup`, or
  similar MUST be present

### Requirement: Route Condition Access

Route conditions MUST be able to predicate on any field of the
resolved actor via the existing JSON-path field-reference primitive
(e.g., `equals: { field: actor.role, value: owner }`).

#### Scenario: Condition Matches Team Member Role

- **GIVEN** A rule with condition `{ equals: { field: actor.role,
  value: 'owner' } }`
- **WHEN** A resolved actor with `role: 'owner'` arrives
- **THEN** The rule MUST match
- **AND** The same condition against `role: 'therapist'` MUST NOT
  match

### Requirement: Stranger Routes

A route MAY explicitly target strangers via `{ equals: { field:
actor.kind, value: 'stranger' } }`. Strangers MUST be processable
(e.g., to issue an "identify yourself" reply). Routes that omit a
stranger-handling branch MUST fall through to the default refuse
behavior.

#### Scenario: Stranger Sent to Identify Rule

- **GIVEN** A rule named `identify-stranger` with condition `{
  equals: { field: actor.kind, value: 'stranger' } }`
- **WHEN** An event from `unknown@example.com` arrives
- **THEN** The `identify-stranger` rule MUST match
