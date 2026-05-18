## Why

Winston has two chat surfaces today (Slack, email) and we want a third (MCP, for therapists). Each surface today has its own route, template, and conversation state. That's getting expensive — every new surface duplicates a template, and the runtime has no way to link conversations across surfaces. Heather emails Winston at 11:00am asking him to draft a reply to Bethany; she Slacks him at 14:00 saying "did you do that thing?" — Winston has no continuous awareness of the prior turn beyond whatever the `winston-personal` memory happens to retrieve by fuzzy similarity. That works often but breaks on tight, pronoun-driven back-and-forth ("change that" / "no, the other one").

Memory is the wrong tool for this. Memory is for durable facts curated by the agent ("Bethany's session is Tuesdays 1pm"). What's missing is a turn log: sequenced, timestamped, surface-tagged, auto-captured, per-actor.

This change introduces three coupled pieces that together close the gap:

1. **Actor resolution.** Every inbound event is normalized to an `actor` (team member, client/parent, or stranger) before the route matches. The route's condition, template render, and tool calls all see the same identity.
2. **Cross-surface interaction log.** Clawndom writes one record per chat-style turn (inbound text + outbound summary + surface + timestamp + actor_id) into Redis. Routes opt into retrieval; writes happen automatically.
3. **Declarative `team:` + `clientLookup:` config blocks.** Workspace authors declare their team members in clawndom.yaml and their client lookup (which spreadsheet, which columns) — Clawndom owns the resolver and storage. No per-workspace TypeScript code.

The change is in scope to ship as a single coherent unit. Migration concerns are minimal because Winston is not yet in production (he serves TALK as the pilot practice; no paying tenants). New stores can be created with the right schema from day one; existing memory entries decay naturally.

## What Changes

- **NEW**: `team:` block on agent `clawndom.yaml`. Declarative list of team members with `id`, `emails`, optional `slack_user_id`, opaque string `role`, opaque string list `permissions`. Loaded into a `TeamRegistry` at boot.
- **NEW**: `clientLookup:` block on agent `clawndom.yaml`. Declarative config for one of N source types (v1 ships `source: sheets`; future: `postgres`, `http`). Workspace specifies which spreadsheet and which columns hold `id`, `parent_emails`, etc. Clawndom owns the implementation; workspaces ship config + data, not code.
- **NEW**: `IdentityResolverService` in Clawndom. Runs after inbound ingestion, before route matching. Walks the resolver chain: TeamRegistry hit → `actor = { id: 't_<slug>', kind: 'team_member', role, permissions, emails }`. Miss → ClientLookup hit on `parent_emails` → `actor = { id: 'c_<6char>', kind: 'parent', child_name, therapist_id, via_email }`. Miss → `actor = { id: null, kind: 'stranger', email: '<raw>' }`. Attaches the resolved `actor` to the event context.
- **NEW**: Route conditions can reference `actor.role`, `actor.kind`, `actor.permissions`, `actor.id`. The existing `equals` / `any_of` / `exists` / etc. primitives work unchanged on these fields.
- **NEW**: `InteractionLogService` in Clawndom. Per-actor Redis sorted set scored by timestamp. Writes happen unconditionally at end-of-run for every route that has a non-null `actor`. Each record: `{ id, actor_id, surface, route, inbound_text, outbound_summary, timestamp, trace_id }`. `outbound_summary` is captured from the agent's final assistant_text (capped at ~500 chars).
- **NEW**: Per-route `interactions:` opt-in block (`interactions: { topN: 5 }`). When present, the worker pulls the last N interactions for this `actor.id` before render and exposes them as `{{ interactions }}` in the template render context.
- **NEW**: Two new capability specs under `openspec/specs/`:
  - `actor-resolution` — the resolver chain, the `actor` shape, the route-condition contract
  - `interaction-log` — the per-actor turn log, the writer/retriever contract, the per-route opt-in
- **MODIFIED**: `worker.service.ts` — runs the resolver before render, runs the InteractionLog writer at end-of-run, runs the retriever per `interactions:` opt-in.
- **MODIFIED**: `agentConfigSchema` — adds optional `team`, `clientLookup` blocks; adds optional `interactions` field on each rule.
- **MODIFIED (winston-agency)**: `workspaces/winston/clawndom.yaml` gains `team:` (10 members) + `clientLookup:` (config + sheet pointer). The `slack-winston` and `gmail-pubsub.email-chat-winston` rules opt in to `interactions: { topN: 5 }`. The existing operator-allowlist email lists in route conditions get replaced by `actor.role` / `actor.permissions` predicates.
- **MODIFIED (winston-agency MCL)**: Add an `id` column to the Active Clients sheet. Add an Apps Script `onEdit` trigger that auto-fills `c_<base32-6>` on new rows. One-time backfill for existing rows.

## Capabilities

### New Capabilities

- `actor-resolution`: Inbound events are normalized to a canonical `actor` before route matching. TeamRegistry (declarative, in clawndom.yaml) resolves team members; ClientLookup (declarative, sheets-source v1) resolves clients via parent emails. Strangers are surfaced explicitly with `actor.kind = 'stranger'`. Route conditions can predicate on actor fields.
- `cross-surface-interactions`: A per-actor turn log captures inbound/outbound text across every chat-style route. Routes opt into retrieval via `interactions: { topN }`. Templates receive the last N turns regardless of which surface they arrived on.

### Modified Capabilities

(none — both new capabilities are additive; existing routes without `team:`, `clientLookup:`, or `interactions:` keep their current behavior)

## Impact

**New code (clawndom):**
- `src/services/identity/` — `team-registry.service.ts`, `client-lookup.service.ts`, `identity-resolver.service.ts`
- `src/services/identity/sources/` — `sheets-source.ts` (the v1 ClientLookup source)
- `src/services/interactions/` — `interaction-log.service.ts` (writer + retriever)
- `src/types/actor.ts` — `Actor` discriminated union shared across services
- Worker integration in `src/services/worker.service.ts` — resolver before render, writer after run, retriever per opt-in
- Schema additions in `src/services/agent-loader.service.ts` — `teamSchema`, `clientLookupSchema`, `ruleInteractionsSchema`
- Capability specs `openspec/specs/actor-resolution/spec.md`, `openspec/specs/interaction-log/spec.md`

**New code (winston-agency):**
- `team:` + `clientLookup:` blocks in `workspaces/winston/clawndom.yaml`
- Updated route conditions to use `actor.role` / `actor.permissions`
- `slack-chat.md` + `email-chat.md` templates reference `{{ interactions }}` and instructions for using them

**New runtime dependencies:** None. Redis (already running) hosts the InteractionLog sorted sets. The sheets-source ClientLookup calls the existing `sheets_get` agency-tools tool (no new HTTP client needed).

**Affected APIs:** None public. New internal service boundaries only.

**Affected configuration:** `clawndom.yaml` gains optional `team:` and `clientLookup:` blocks; routes gain optional `interactions:` block. No env-var changes. Existing agents without these blocks parse and run unchanged.

**Per-tenant operator work (per Winston-clone practice):**
- Author the `team:` block in clawndom.yaml (~5 entries, hand-maintained, ~10 min)
- Author the `clientLookup:` block pointing at the practice's MCL sheet (~5 min)
- Add an `id` column to the MCL + drop in the Apps Script trigger (~10 min, scriptable later via Workspace Admin SDK)

This work folds cleanly into the bootstrap-tenant script we sketched earlier — three lines of config plus a one-time MCL schema operation.
