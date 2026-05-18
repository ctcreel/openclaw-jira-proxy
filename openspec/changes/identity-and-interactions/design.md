## Context

Winston serves a team. That team currently includes Heather (owner / office manager), Chris (engineer / reviewer), Piper (assistant), and four therapists (Bethany, Alisha, Clare, Yvonne). They reach Winston via Slack DMs, Slack mentions, the Slack assistant sidebar, emails to winston@, and (in the very-near future) MCP from inside their own Claude / Cursor sessions.

Today each surface has its own route, its own template, and its own conception of identity:

- `slack-winston.chat` matches by Slack message type + channel-type predicates, never by sender.
- `gmail-pubsub.email-chat-winston` matches on `emailAddress`.
- The route conditions encode trust levels as regexes / equals checks on email addresses ("if from heather@ or chris@ → full trust; if from a therapist → scoped; if from a parent → narrow; else refuse").

Three problems compound:

1. **Duplication.** The trust/scoping logic is reasonably uniform across surfaces but encoded surface-by-surface. Adding MCP duplicates again.
2. **No cross-surface continuity for turns.** The `winston-personal` memory namespace gives semantic continuity on person-centric and topic-centric queries, but fails on tight back-and-forth ("change that" / "the other one"). The recent-turn-log gap is real.
3. **No first-class identity.** "Bethany" is a regex-matched email today, not an entity. Memory entries that mention her are stored as text and retrieved by similarity. Audit records reference her by email. Calendar lookups fuzzy-match her name. Every consumer reinvents identity.

The fix needs to address all three. The right shape is:

- **One canonical identity** (`actor`) attached to every event in the runtime
- **One turn log** (cross-surface, per-actor) that any chat-style route can opt into
- **Declarative configuration** of who's on the team and where the client list lives — workspaces stay code-free

## Goals / Non-Goals

**Goals:**

- A single `actor` value attached to every event, with three discriminated kinds: `team_member`, `parent`, `stranger`. Routes can condition on actor fields. Templates can read `{{ actor.role }}`.
- TeamRegistry as declarative config in clawndom.yaml. Source-controlled, reviewable, small. Hand-maintained per tenant.
- ClientLookup as declarative config (workspace points at its data source); the source implementation is Clawndom-side. v1 ships `source: sheets`; the schema is extensible to future sources.
- InteractionLog as a Clawndom service that writes unconditionally on every route with a resolved actor, and is read per-route via `interactions:` opt-in. Single Redis sorted set per actor.
- Promise-returning identity resolver (Node-idiomatic), with no framework-level caching abstraction. Implementations are responsible for being fast; the sheets source caches in-memory and refreshes on a TTL.
- Migration-free: Winston isn't in production, the new stores are created with the right schema from day one, existing memory entries are unaffected (different namespace) and decay naturally.
- A clean per-tenant productization story: stamping out tenant N's Winston is "write a `team:` block + a `clientLookup:` block + run the MCL Apps Script." No new code per tenant.

**Non-Goals:**

- **Cross-workspace identity.** Patch's contributors and Winston's clients are different domains. We don't try to share an identity store across agent products; if a hypothetical future use case needs federated identity, it's a separate change.
- **Conversation-id linkage.** We're not building an explicit "this email and this Slack thread are the same conversation" linker. The interaction log gives ordered per-actor history; the agent infers continuity from the prose, same as a human would.
- **Plugin / executable workspace code.** ClientLookup is declarative. Workspaces ship YAML + data + templates + (Python) tools — never TypeScript modules dynamically loaded by Clawndom. If a workspace needs identity logic that no declarative source supports, that's a Clawndom feature request.
- **Auto-distillation of interaction-log entries into memory.** The interaction log is recent-turn raw text; the memory namespace is curated facts. A future process could promote interaction-log entries to memory, but that's a separate, opinionated decision and out of scope.
- **Strangers-with-IDs.** Strangers stay stranger-keyed (email only) until promoted to a TeamRegistry entry or an MCL row. We don't generate `s_<id>` identifiers for one-off contacts.
- **Multi-instance Clawndom.** Same single-instance assumption that's already baked into the rest of the system.
- **Migration tools.** Winston isn't in production. Wipe and rebuild is acceptable.

## Decisions

### Decision 1: Three components shipped as one change

TeamRegistry, ClientLookup, and InteractionLog are coupled by the `actor` shape. Shipping any one without the others creates a transition period where some events have resolved actors and others don't, and where interaction-log entries carry inconsistent actor identifiers. Staging gets you no value until all three are present, and creates real cleanup work between stages. Ship as one cohesive change with one new `actor` contract.

### Decision 2: Declarative ClientLookup, not pluggable code

Earlier in the design conversation we considered making ClientLookup a port that workspaces implement in TypeScript. We rejected this in favor of declarative config (`clientLookup: { source: sheets, ... }`) for three reasons:

1. **Productization.** Stamping out tenant N means writing a YAML block, not shipping code. The bootstrap-tenant script writes the block from the manifest. Tenants without `clientLookup:` (Patch, future system agents) just skip that step of the resolver chain.
2. **Build hygiene.** Workspaces stay config + templates + data + Python tools. No per-workspace TS build / test / type-check pipeline. Adding executable code per workspace would multiply CI surface area by N tenants.
3. **Reuse.** If a hypothetical future agent needs `source: postgres`, that's one Clawndom change that every Clawndom tenant gets. If we'd used the port pattern, every workspace that wanted postgres would write its own implementation.

The tradeoff: workspaces with truly bespoke identity logic (a one-off "look in this proprietary CRM via this auth scheme") need Clawndom to grow a new source type. That's the right place for the burden — it's reusable infrastructure, not per-tenant overhead.

### Decision 3: Resolver runs at request time, not boot time

Earlier we considered a "bootstrap from MCL at boot" model: Clawndom loads the MCL at startup and any new client added during the day requires a restart. Rejected because:

- Heather adds clients during the day; Winston should resolve them at the next inbound, not after a service restart.
- Boot-time loading creates an ambiguous source of truth (the in-memory snapshot vs. the live sheet). Runtime resolution treats the sheet as truth.

The implementation: the sheets-source maintains an in-memory snapshot, refreshes on a configurable TTL (default 5 minutes), and serves lookups from the snapshot. The MCL is the source of truth; the snapshot is a performance optimization the implementation owns. Clawndom's contract is just "be fast and accurate."

### Decision 4: Promise-returning port signature, no framework cache

Identity resolver is `async`. The port's contract is "be fast and return null on miss"; HOW the implementation achieves that (in-memory cache, periodic refresh, on-write invalidation) is implementation-owned. Clawndom does not provide a cache abstraction.

This means future sources (postgres, http) can do I/O without protocol changes, and the in-memory sheets source returns in microseconds without Clawndom needing to know.

### Decision 5: Unconditional write, opt-in retrieval

The interaction log is **always written** when the resolved `actor` is non-null. Writes are cheap (one Redis ZADD); they happen at end-of-run; they need no agent involvement.

Retrieval is **per-route opt-in** via `interactions: { topN: N }`. Routes that don't care (the gmail-watch refresh job, the builder-callback relay) don't pay the read cost and don't get `{{ interactions }}` in their template context.

The asymmetry is deliberate: writing is cheap and the data has retroactive value (audit, debugging, future retrieval analytics). Reading is per-context — the morning-briefing scheduled prompt does not benefit from Heather's recent Slack turns.

### Decision 6: Strangers get no ID

Strangers stay `{ id: null, kind: 'stranger', email: '<raw>' }`. They can have interaction-log entries keyed by their email (formatted `stranger:<email>` in the actor_id field) — that lets routes still pull "what did this address ask before" for repeat strangers, but the data doesn't pretend to canonicalize a non-canonical identity.

Promoting a stranger to a TeamRegistry or MCL entry is a manual operator action (edit yaml or add a sheet row). Stranger interaction-log entries from before promotion are NOT migrated — they decay with normal log retention. This is the same migration-free posture as the rest of the change.

### Decision 7: MCL Apps Script handles ID assignment

The MCL is a Google Sheet edited by Heather. Adding stable IDs requires Apps Script:

- onEdit trigger on the Active Clients sheet
- If the `id` cell is empty and the row has content, generate `c_<base32-6char>` and write
- Bounded: at most one assignment per edit event

The script is small (~30 lines) and the same shape across tenants. The bootstrap-tenant script deploys it via the Workspace Apps Script API.

Existing rows get backfilled by running the script manually over them once at migration time.

### Decision 8: Role and permissions are opaque to Clawndom

Earlier in the design we sketched closed-enum permissions like `client_scoped`. That was wrong — `client_scoped` is Winston vocabulary, not Clawndom vocabulary. Patch wouldn't use it.

Clawndom treats `role` and `permissions` as opaque strings. The schema validates that they're strings; the workspace decides what they mean. Route conditions compare against literal strings the workspace authored.

This keeps the same separation that already exists between Clawndom (condition primitives, schema) and the workspace (the actual values the conditions match against).

### Decision 9: Interaction-log retention strategy

Per-actor sorted sets are bounded by:

1. A per-actor max length (default 200 turns). Older entries are trimmed via ZADD's LIMIT/incremental trim. This is a Redis-native operation, no cron needed.
2. A global TTL (default 180 days) so abandoned-actor data doesn't accumulate forever. Run as a daily prune similar to memory pruning.

Both numbers are configurable per agent in the new `interactions:` top-level block on clawndom.yaml. Defaults are fine for the speech-therapy use case; bigger agents can tune.

## Open Questions

These need answers before implementation but are not blockers to the design shape:

1. **MCL schema discovery.** The `clientLookup.columns:` config maps a column-name string (e.g. `parent_emails`) to a sheet header. Do we identify columns by header text (fragile to header rename but human-readable) or by column letter (stable but opaque)? Header text wins on author experience; we accept the rename-fragility risk and document it.

2. **Parent_emails delimiter.** A single cell can hold multiple parent emails. Pipe (`a@b.com|c@d.com`) vs comma vs semicolon. Pipe is unambiguous and easy to author; commas conflict with how some sheets auto-parse on import. Default pipe; configurable in clawndom.yaml.

3. **Therapist FK validation at boot.** The MCL row carries `therapist_id` pointing into `team:`. At boot we can validate every therapist_id resolves; on refresh the validation runs again. What if a row's therapist_id doesn't resolve? Two options: hard-fail boot (forces operator to fix), or warn and resolve `actor.therapist = undefined`. Default warn — boot should not hang on Heather mistyping a column.

4. **Slack identity for new team members.** A new therapist joins; their `slack_user_id` isn't in `team:` yet. Until it is, Slack DMs from them resolve to stranger. Operator notices via interaction-log review or via the audit log. Acceptable lag — same as the current operator-allowlist refresh cycle.

5. **MCP identity.** Once the MCP server lands (separate, follow-on change), the OIDC `email` claim from the therapist's Google Workspace JWT is the identity hint. The TeamRegistry `emails[]` field already handles it. No new wiring needed.

6. **Cross-tenant Clawndom.** Out of scope for this change (single-tenant assumption), but worth flagging: the TeamRegistry is per-clawndom-instance. Across multiple Clawndom tenants there's no shared identity. That's intentional — every practice is its own bubble.

7. **MCL refresh during long-running operations.** If a route fires at 14:00:00, refreshes the MCL at 14:00:01, and runs until 14:30:00, are subsequent ClientLookups during that 30-minute run hitting the 14:00:01 snapshot or the next 5-minute refresh? Implementation choice: snapshot the resolver state per-job, not per-call. A single job sees a consistent identity universe even if it runs across a refresh boundary.

## Capability spec stubs

Two new capability specs land with this change:

- `openspec/specs/actor-resolution/spec.md` — defines the `Actor` type, the resolver chain semantics, the `team:` and `clientLookup:` schemas, the route-condition contract on `actor.*` fields, and the failure modes (unresolvable actor, malformed config, ID collision).

- `openspec/specs/interaction-log/spec.md` — defines the record shape, the per-actor sorted-set semantics, the writer triggers, the `interactions: { topN }` retrieval contract, the trim and prune policies.

Both are added in this change; neither modifies an existing capability.
