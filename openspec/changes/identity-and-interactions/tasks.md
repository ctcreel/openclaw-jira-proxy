## 1. Schemas and types

- [ ] 1.1 `src/types/actor.ts` — discriminated `Actor` union: `team_member` (id, role, permissions, emails), `parent` (id, child_name, therapist_id, via_email), `stranger` (id=null, email). Shared across services so producer/consumer types match.
- [ ] 1.2 `src/services/agent-loader.service.ts` — add `teamSchema` (array of `{id, emails, slack_user_id?, role?, permissions?}`), `clientLookupSchema` (discriminated union on `source`; v1 has only `sheets` member with `spreadsheet_id`, `sheet_name`, `columns: { id, child_name?, parent_emails, therapist_id? }`, optional `refresh: '5m'`-style duration). Make both top-level optional fields on `agentConfigSchema`.
- [ ] 1.3 Per-rule `ruleInteractionsSchema`: `{ topN: positive integer, default 5 }`. Add as optional field on `agentRuleSchema`.
- [ ] 1.4 Top-level `interactionsSchema` on `agentConfigSchema`: `{ maxLogLength: positive int default 200, retainDays: positive int default 180 }`. Per-agent tuning knobs.
- [ ] 1.5 Validation: `team:` member IDs unique within agent. `team:` member emails unique within agent (no two members share an email). `clientLookup.columns.parent_emails` is required when `clientLookup:` is present. Tests cover each rejection path.
- [ ] 1.6 ID format validation: team IDs match `/^t_[a-z][a-z0-9_]*$/`. Client IDs match `/^c_[a-z0-9]{6}$/` (assigned by the MCL, but the resolver validates on read so a malformed MCL row gets caught early).

## 2. TeamRegistry service

- [ ] 2.1 `src/services/identity/team-registry.service.ts` — `TeamRegistry` class with `lookupByEmail(email)`, `lookupBySlackUserId(slackUserId)`, `lookupById(id)`. All return `TeamMember | undefined`. Built at boot from the `team:` block of one agent's config. One registry per loaded agent.
- [ ] 2.2 Case-insensitive email matching (canonicalize lowercase on both insert and lookup).
- [ ] 2.3 Tests: lookup hits, lookup miss, case insensitivity, multi-email member, empty registry edge case.

## 3. ClientLookup service

- [ ] 3.1 `src/services/identity/client-lookup.service.ts` — abstract `ClientLookupSource` interface: `lookupByEmail(email): Promise<ClientRecord | null>`, `lookupById(id): Promise<ClientRecord | null>`, `refresh(): Promise<void>`. Each source implementation builds its own in-memory snapshot.
- [ ] 3.2 `src/services/identity/sources/sheets-source.ts` — implements `ClientLookupSource`. On `refresh()`, calls `sheets_get` (via existing internal sheets fetch helper or direct Google Sheets API client — choose lowest-friction path) to read the configured `spreadsheet_id` and `sheet_name`. Parses header row, maps `columns:` config to indices, builds `parent_email → ClientRecord` map and `id → ClientRecord` map. Atomic snapshot swap on successful refresh; old snapshot served if refresh fails.
- [ ] 3.3 Refresh scheduler: timer per source, runs every `refresh:` duration (default 5m). First refresh runs synchronously at boot (so the resolver is ready by the time inbound traffic arrives).
- [ ] 3.4 ClientLookup factory: given a `clientLookupSchema` config, returns the right source implementation. Throws on `source:` values without a registered implementation. v1 throws on anything but `sheets`.
- [ ] 3.5 No `clientLookup:` block in agent config → ClientLookup is `undefined` and the resolver chain skips that step.
- [ ] 3.6 Tests: sheets-source happy path with a recorded response, snapshot atomicity (failed refresh keeps old snapshot), missing required column (`parent_emails`) fails at boot, malformed `id` cell (`c_` prefix missing) is dropped from the snapshot with a warn log, refresh error doesn't crash the agent.

## 4. Identity resolver

- [ ] 4.1 `src/services/identity/identity-resolver.service.ts` — `IdentityResolver` class with `resolve(hints: IdentityHints): Promise<Actor>`. `IdentityHints` shape: `{ email?, slack_user_id?, oidc_email? }` — surface adapters fill in whichever they know.
- [ ] 4.2 Chain order: try `slack_user_id` against TeamRegistry; try `email` (or `oidc_email`) against TeamRegistry; try `email` against ClientLookup `parent_emails`; fall back to `{ id: null, kind: 'stranger', email }`.
- [ ] 4.3 Resolver result is attached to the event context as `actor`. The route-matching layer can predicate on `actor.id`, `actor.kind`, `actor.role`, `actor.permissions` via the existing condition primitives.
- [ ] 4.4 Tests: every chain step (team-by-slack, team-by-email, client-by-parent-email, stranger fallback), conflicting hints (a Slack user ID in team registry, but the email in MCL — team wins), missing TeamRegistry, missing ClientLookup.

## 5. Surface-adapter identity hints

- [ ] 5.1 `src/strategies/transport/slack-socket.transport.ts` — when constructing the event context, also include `identityHints: { slack_user_id: event.user, email: <resolved via users.info if cached, else undefined> }`. Don't synchronously call `users.info` per inbound; rely on the TeamRegistry's slack_user_id field for the common case.
- [ ] 5.2 `gmail-pubsub` webhook ingest — `identityHints: { email: <emailAddress from the Pub/Sub claim> }`.
- [ ] 5.3 `/api/tasks` internal dispatch — `identityHints: { email: context.dispatching_actor_email }` or similar; defines a convention for dispatches that carry actor info.
- [ ] 5.4 Tests for each adapter that the right hints land on the event context.

## 6. Route conditions over `actor`

- [ ] 6.1 Existing condition evaluators in `src/strategies/routing/` need no changes — they already work on arbitrary JSON-path field references. Add documentation that `actor.*` is a usable field path.
- [ ] 6.2 Update the routing schema export (`src/controllers/schema.controller.ts`) so the editor's condition-builder includes `actor.id`, `actor.kind`, `actor.role`, `actor.permissions` as autocomplete suggestions.
- [ ] 6.3 Tests: a route condition `{ equals: { field: actor.role, value: owner } }` matches when actor.role is `owner`, doesn't match when it's `therapist`, doesn't match when actor.kind is `stranger`.

## 7. InteractionLog service

- [ ] 7.1 `src/services/interactions/interaction-log.service.ts` — `InteractionLog` class with `record(entry: InteractionEntry)` and `recent(actorId: string, limit: number): Promise<InteractionEntry[]>`. Backed by Redis sorted set per actor: key `interactions:<agent_id>:<actor_id>`, score = `timestamp_ms`, member = JSON of the entry.
- [ ] 7.2 InteractionEntry shape: `{ id: ulid, actor_id, surface: 'slack'|'email'|'mcp'|<...>, route: '<provider>.<rule>', inbound_text: string, outbound_summary: string, timestamp: number, trace_id: string }`. `outbound_summary` is the agent's final assistant_text, truncated at 500 chars (with `...` suffix marker if truncated).
- [ ] 7.3 Writer hook in `worker.service.ts` — at end-of-run, after audit emission, write to interaction log when `actor.id !== null` AND the route is chat-style (heuristic: route has a `messageTemplate` AND its provider is one of the surface providers; explicit opt-out flag also supported). Failure to write logs an error but doesn't fail the job.
- [ ] 7.4 Strangers: write to `interactions:<agent>:stranger:<email>` so repeat-stranger context is still queryable. Same shape, different key prefix.
- [ ] 7.5 Per-actor max length: `maxLogLength` from `interactions:` agent config (default 200). After each ZADD, ZREMRANGEBYRANK to keep the set bounded.
- [ ] 7.6 Daily prune service (parallel to memory-pruning): on a schedule, scans all interaction-log keys and deletes entries older than `retainDays` (default 180).
- [ ] 7.7 Tests: write+read round trip, max-length trim, prune deletes only old entries, stranger key separation, failure to write surfaces as a logged error not a thrown one.

## 8. Pre-render retrieval injection

- [ ] 8.1 Worker render path: when the matched rule has `interactions: { topN }` AND `actor.id` is non-null, call `InteractionLog.recent(actor.id, topN)` before render. Pass the result into the template engine as `interactions` (mirror of the existing `{{ memories }}` injection from agent-memory).
- [ ] 8.2 Template engine: register `{{ interactions }}` as a known variable that renders as a formatted block. Default formatter renders one line per turn: `[<surface> @ <iso-timestamp>] inbound: "<text>" / outbound: "<summary>"`. Templates that want richer rendering can do their own iteration via existing Liquid-ish primitives.
- [ ] 8.3 Strangers with non-null email: routes that opt into `interactions:` AND have an actor with `kind: stranger` get the stranger key's history (`stranger:<email>`). Same surface to the template, just keyed differently under the hood.
- [ ] 8.4 Tests: opt-in route gets `{{ interactions }}` populated, opt-out route doesn't render anything for it, stranger actor pulls from stranger key, empty history renders as an explicit "no prior turns" placeholder string.

## 9. agency-tools (none new)

This change does NOT add new agency-tools tools. The interaction log is internal Clawndom plumbing; templates consume it via the `{{ interactions }}` variable, not via a tool call.

## 10. winston-agency: config and template updates

- [ ] 10.1 Add `team:` block to `workspaces/winston/clawndom.yaml`. Initial set: heather, chris, piper, bethany, alisha, clare, yvonne. Each with `id`, `emails`, `slack_user_id`, `role`, `permissions`. Permissions vocabulary: `full_trust`, `client_scoped`, `builder_dispatch`, `read_only`.
- [ ] 10.2 Add `clientLookup:` block pointing at the current MCL spreadsheet. Confirm column names match the actual sheet headers.
- [ ] 10.3 Add `interactions:` top-level block with `maxLogLength: 200`, `retainDays: 180` (defaults — explicit so future operators see the knob).
- [ ] 10.4 Update `slack-winston.chat.condition` — replace the existing event-shape predicates with the same predicates AND an `actor.role` check that admits team members + parents and refuses strangers (or routes strangers to a different rule that asks them to identify themselves).
- [ ] 10.5 Update `gmail-pubsub.email-chat-winston` similarly. The existing `condition: { equals: { field: emailAddress, value: winston@... } }` stays; trust-tier logic moves out of the template prose and into condition fields on `actor.role`.
- [ ] 10.6 Opt in to interactions retrieval on both routes: `interactions: { topN: 5 }`.
- [ ] 10.7 Update `templates/slack-chat.md` and `templates/email-chat.md` to consult `{{ interactions }}` at the top of the run ("Step 0: read these prior turns before responding").
- [ ] 10.8 Update `templates/email-chat.md` and `templates/slack-chat.md` to reference `{{ actor.role }}`, `{{ actor.id }}`, `{{ actor.permissions }}` instead of regex-matching emails in prose.
- [ ] 10.9 Re-render README routing graph (CI catches drift; do this before pushing).

## 11. winston-agency: MCL schema

- [ ] 11.1 Add an `id` column to the Active Clients sheet of the MCL (first column).
- [ ] 11.2 Deploy an Apps Script `onEdit` trigger: when a row gains content and the `id` cell is empty, fill it with `c_<base32-6>` (using `crypto.getRandomValues` from Apps Script's `Utilities`).
- [ ] 11.3 One-time backfill: run a manual script over existing rows to populate `id`. Verify against the live `parent_emails` column that there are no duplicates.
- [ ] 11.4 Confirm `therapist_id` column exists and is populated for active clients. If it's currently free-text (e.g. "Bethany"), normalize to team IDs (`t_bethany`) as part of the backfill.

## 12. Verification

- [ ] 12.1 Local end-to-end: spin up clawndom-winston locally, send a synthetic Slack-format event from Heather, verify the audit log records `actor: { id: t_heather, role: owner, ... }`, verify the interaction log has the entry afterward.
- [ ] 12.2 Same as above for a synthetic email event from a parent (using a real-looking `parent_emails` value from the MCL); verify `actor.kind = parent`, `actor.therapist_id` populated.
- [ ] 12.3 Stranger case: synthetic event from an unknown email; verify `actor.kind = stranger`, interaction log uses the stranger key.
- [ ] 12.4 Cross-surface continuity: send a synthetic email from Heather, then a synthetic Slack DM from Heather, verify the second event's render context has the first event's interaction as `{{ interactions }}`.
- [ ] 12.5 Pin agency-tools `ref` in `/etc/clawndom-winston/clawndom.env` if any agency-tools changes happen during implementation (none expected — this change is Clawndom-only on the runtime side).
- [ ] 12.6 Deploy: merge → bump pinned agency-tools / winston-agency refs in `clawndom.env` per [[agency-tools-pinned-sha]] → restart clawndom-winston → tail logs.

## Out of scope (deferred consciously)

- MCP server / `mcp-winston` provider (separate change)
- Chat-core template refactor (`_chat-core.md` shared partial). Useful but independent; can land before or after this without coupling.
- Federated identity across Clawndom tenants
- Auto-distillation from interaction log to memory namespace
- Postgres or HTTP `clientLookup.source:` implementations
- Operator UI for editing TeamRegistry / MCL (everything stays in YAML + Sheets for now)

## Estimated effort

| Section | Days |
|---|---|
| 1. Schemas + types | 0.5 |
| 2. TeamRegistry | 0.5 |
| 3. ClientLookup (sheets source) | 1.5 |
| 4. Identity resolver | 0.5 |
| 5. Surface-adapter hints | 0.5 |
| 6. Route conditions (mostly free, just docs/schema export + tests) | 0.25 |
| 7. InteractionLog service | 1.0 |
| 8. Retrieval injection | 0.5 |
| 10. winston-agency config + template updates | 0.75 |
| 11. MCL schema + Apps Script | 0.25 |
| 12. Verification | 0.5 |
| **Total** | **~6.75 days** |

Coverage gate (95% statements / lines / functions, 88% branches) adds ~1 day to the testing line items; included.
