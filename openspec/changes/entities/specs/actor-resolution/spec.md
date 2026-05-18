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

### Requirement: Resolver Chain (Schema-Auto-Discovered)

The resolver MUST auto-discover which entity kinds participate in
identity resolution by reading the workspace schemas. A kind is in
scope for identity resolution if its schema declares any property
with `"format": "email"` (for email/oidc_email hints) or a property
named `slack_user_id` (for slack_user_id hints). No separate
resolver-config block is required.

Given `IdentityHints { email?, slack_user_id?, oidc_email? }`, the
resolver MUST try in this order, returning on first match:

1. `slack_user_id` hint against any kind that declares a
   `slack_user_id` property
2. `email` / `oidc_email` hint against any kind that declares an
   email-typed property (case-insensitive match on the property
   value)
3. Fallback to stranger.

When the matched entity is a `client`-style kind (i.e., the entity
represents the subject of the agent's domain rather than a
communicator), the resolver MAY follow outgoing `is_contact_for`-
style relations to surface the related client(s) in the returned
actor. Implementation discovers this via the schema-declared
relation graph.

The resolver MUST NOT consult any source outside the entity store.

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
