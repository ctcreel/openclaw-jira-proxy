## Context

clawndom is a standalone Express.js webhook proxy with BullMQ + Redis. It accepts external-provider webhooks (Jira, GitHub, Linear, …) on provider-specific HMAC-signed routes, queues events, and dispatches them to pluggable runners that execute agents under a completion-aware serialization gate.

Each agent has an entry in `AGENTS_CONFIG` (env-var JSON) with shape `{name, repo, path?, ref?, sharedTools?}`. `loadAgents()` runs once in `startServer()` (`src/server.ts:314`): it clones each agent's repo (one clone per unique repo, since multiple agents can colocate in the same repo via different `path` subdirectories — Patch and Scarlett both live in `the-agency`), optionally pins to a tag/SHA, reads each agent's `clawndom.yaml`, and produces the in-memory `ResolvedAgent[]` that the runtime serves from for the rest of the process lifetime. There is no hot reload — changes to agent definitions require a clawndom restart to take effect.

An agent (Winston is the current operator-facing example) typically serves a mixed audience — civilians (external email senders, public Slack channels) and operators alike land on the same agent. Agents have been informally used to make platform-style improvements from inside the runtime; Winston recently embedded bash scripts into templates rather than defining proper tools, because nothing in his role told him not to. Once civilians have an unfiltered path to an agent that can also modify its own definition, every civilian message becomes a potential prompt-injection vector for self-modification.

This change introduces a security boundary the platform doesn't currently have: **system agents** — agents centrally defined in clawndom and dispatched through authenticated operator paths only — and a first instance — **Builder** — that owns add/change/delete work scoped to the dispatching agent's directory.

Outside agents the user (or operators) wield against repos from outside the runtime — Patch and Scarlett for general software-development work — are not runtime-resident, are not dispatched through the agent runtime, and are outside this change.

## Goals / Non-Goals

**Goals:**

- Make agent self-modification authority a *capability* an agent either has or does not have, where the absence is **structural** (the tool isn't loaded) rather than **discretionary** (the prompt says don't).
- Give operators a path to ask an agent to add, change, or delete one of the agent's own capabilities through their existing conversation, without exposing that path to civilians.
- Encode the platform's what-goes-where conventions inside Builder so changes made through Builder respect the architecture by construction.
- Keep every hop non-blocking; long-running work happens in BullMQ; callbacks are idempotent.
- Keep state surface small: Builder's working state lives on her git branch (plan-as-markdown + WIP commits); resume requires no external state store.
- Centralize Builder's definition once in clawndom so every dispatching agent gets a consistent implementation.

**Non-Goals:**

- Generalizing a `SystemAgent` framework. Builder is hand-rolled; extract once a second system agent proves the shape.
- Outside agents (Patch, Scarlett, etc.). Different security model, different invocation surface, not runtime-resident — out of scope.
- Cross-agent improvements. Builder operates against exactly one dispatching agent's directory per job.
- Hot-reload in clawndom. v1 uses an external-orchestrator restart (option 1); hot-reload (option 3) is filed as a separate follow-on.
- Builder talking to users directly. The dispatching agent owns the user voice; Builder only ever talks back to that agent via callbacks.
- Auto-merge or auto-deploy. Builder opens PRs; merging is governed by the repo's normal review process; restart is governed by the existing supervisor.

## Decisions

### D1. System vs ordinary agents is a security boundary

The defining property is **who can reach them**. Ordinary agents serve mixed audiences (civilians + operators); system agents are reachable only through operator-authenticated paths. Code location, credentials, and scope follow from that.

- Alternative considered: keeping Builder as just another agent in someone's agent repo — rejected. Once civilians can reach any agent, the boundary is conventional (prompt-discipline) rather than structural (tool-absence).
- Alternative considered: per-agent ACLs at the dispatch layer in lieu of tool-presence — rejected. ACLs are runtime checks (prompt-injection-evadable); tool-presence is not.

### D2. Tool presence is the primary defense

`dispatch_to_builder` is loaded into the dispatching agent's tool list **only when that agent is invoked on a privileged route**. On non-privileged routes the tool is not in the agent's context at all — no prompt-injection payload can call a tool that doesn't exist.

The privileged-route template additionally enforces an operator-allowlist (Layer 2: sender identity check), and Builder re-verifies sender identity on dispatch receipt (Layer 3). Both are belt-and-suspenders, never the primary gate.

### D3. Builder lives in clawndom; her target is the dispatching agent's directory

Builder's definition (system prompt, plan template, tool list) lives at `src/system-agents/builder/` in clawndom. There is one Builder definition shared across all dispatching agents. The path is deliberately `system-agents/` (not `agents/`) so it doesn't collide with the "agents" concept used by clawndom's external-agent loader (`AGENTS_CONFIG` → `loadAgents`). Each dispatch carries `agentName`, which Builder's runner resolves against `AGENTS_CONFIG` to find:

- Target repo and `path` (the dispatching agent's directory)
- Builder bot identity for that repo (resolved per-repo, since colocated agents share a repo)
- Branch naming convention
- Operator allowlist (per-agent, not per-repo)
- `testable_mechanism` (per-agent)

Builder MUST modify files only under the dispatching agent's `path`. She MUST NOT modify other colocated agents' paths, the agent's `sharedTools` directory (pinned by ref; requires a separate coordinated change that also bumps the agent's `clawndom.yaml` ref), or clawndom itself.

- Alternative considered: a separate Builder per agent — rejected; centralization gives consistency.
- Alternative considered: putting Builder's definition inside each agent's directory — rejected; bootstrapping risk.

### D4. New internal-bearer strategy, not reused external HMAC

External provider routes use HMAC with shared secrets per provider. Internal dispatch from an opting-in agent → clawndom uses a bearer token in `Authorization: Bearer …`, validated against a value held in the platform's secret store via `crypto.timingSafeEqual`. The new strategy lives in `src/strategies/` alongside `websub` and `github`, selected by route config.

### D5. One Builder queue across all dispatches (v1)

Builder gets one dedicated BullMQ queue. All dispatches share it; the existing completion-aware serialization (one job at a time per queue) means a long-running Builder job doesn't affect external-provider queues. Per-agent partitioning is a future optimization.

### D6. Reply-context envelope is opaque to Builder

The dispatching agent attaches `{channel, thread_ts | message_id, senderEmail, originalRequestText}` to the dispatch payload. Builder treats this as an opaque blob and echoes it back on every callback. The dispatching agent is responsible for using it to reply to the original Slack thread or email. This keeps Builder out of Slack/Gmail tool grants entirely.

### D7. Lifecycle states are explicit and four

`working`, `question_pending`, `testable`, `failed`. Each transition is a callback POST to `/webhooks/builder-callback`. The states are user-visible (the dispatching agent renders them). The `failed` state is mandatory; without it, a stuck Builder strands the operator silently.

### D8. Restart strategy: external orchestrator (option 1)

Clawndom has no hot reload today. `loadAgents()` runs once at startup and the in-memory agent set is frozen for the process's lifetime. A Builder change therefore becomes live only after clawndom is restarted.

**v1: external orchestrator.** After Builder's PR is merged, the existing supervisor (PM2 / systemd / k8s deployment) restarts clawndom. After the new instance comes up healthy, the supervisor fires a deploy webhook (`POST /webhooks/builder-deploy-complete` with the affected `jobId`); Builder's callback handler treats it as the `testable` signal and dispatches the operator reply.

- The `testable_mechanism` enum stays as specified — `deploy_webhook` is the default for clawndom-resident agents.
- `cache_refresh` remains valid for the future-state hot-reload follow-on; `pr_preview` remains valid for agents that have external preview environments.
- BullMQ persists jobs across restarts, so in-flight Builder jobs whose runners are killed mid-restart resume on the new instance.
- Trade-off: every Builder dispatch causes a clawndom restart. Acceptable when restarts are seconds and the supervisor does graceful shutdown; painful for high-traffic deployments.
- Alternative considered: self-restart callback (option 2) — rejected. Bootstrapping problem (Builder would kill the process running her own job; the in-flight callback dies with it). No real benefit over option 1.
- Follow-on: option 3 (hot-reload in clawndom) is the architecturally right long-term answer. File as a separate change after v1 ships.

### D9. Pause/resume via git-native state

When Builder pauses with `question_pending`, she commits her plan as `.builder/plan.md` to her working branch. The callback carries `{question, branch, planPath}`. The dispatching agent relays the question. The operator's answer triggers a new Builder dispatch carrying `{agentName, resume: {branch, answer}}`. Builder re-hydrates by checking out the branch and reading the plan. No separate state store.

### D10. Idempotency via `eventId` on every callback

Each callback carries `eventId = jobId + state_name` (e.g., `builder-job-42:testable`). The callback consumer dedupes against a Redis-backed store (24h TTL by default). Retried deliveries cannot cause double-replies.

### D11. Per-agent-repo Builder identity; branch protection is a bot allowlist

Each opted-in agent-repo provisions its own dedicated Builder GitHub App (e.g., `the-agency-builder[bot]`), installs it on that repo, and stores credentials in 1Password under `Engineering`. Builder's runner resolves which bot to use from the dispatching agent's repo (via `AGENTS_CONFIG`). Colocated agents share the same Builder bot for their shared repo, but Builder still scopes her modifications to the *dispatching* agent's path.

Branch protection on each repo's `main` requires PR author to be in an **approved-bot allowlist** maintained per-repo. For `the-agency` today that allowlist would include `{the-agency-builder[bot], patch[bot], scarlett[bot]}` — Builder plus the user's existing outside-agent bots. Unknown identities are still rejected, but legitimate non-Builder authoring against the same repo continues to work.

- Alternative considered: "only Builder's bot may author PRs" — rejected. Would block the user's existing dev workflow via Patch/Scarlett, which author PRs from outside the runtime against the same repos. Branch protection can't distinguish inside-vs-outside.
- Alternative considered: one shared Builder bot across all repos — rejected; per-tenant blast radius is better, and per-repo installations are how GitHub Apps naturally work.

### D12. Filesystem boundary for non-Builder agents

Every agent that is not Builder receives no filesystem-write tools, mounts source read-only at the OS level, and starts each invocation from a fresh checkout. Prompt injection cannot produce a local-only modification that survives.

### D13. Hand-rolled, not framework-extracted (yet)

The Builder shape (route + queue + runner + per-repo identity + callback contract) is likely to repeat for future system agents. We are not pre-extracting a framework. The test is the second system agent: if it retrofits, extract then.

### D14. No blocking calls anywhere

Every HTTP hop returns 202. No agent waits synchronously for another agent. The dispatching agent's reply to the operator happens via a short Slack/Gmail API call triggered by a callback, not by holding a connection open against Builder.

### D15. Repo hygiene encoded in Builder

Builder's system prompt MUST encode standard engineering hygiene: fetch latest before fresh jobs, use the agent's configured branch-naming convention, never bypass pre-commit hooks or signing flags, run the agent's verification command (`make check-all` or configured equivalent) before opening a PR, never commit secrets or large binaries, use the agent's commit-message style, and clean up working branches after terminal states. These are explicit requirements with scenarios, not assumptions.

### D16. Provisioning is operator-driven, never Builder-self-driven

Opting an agent (and its repo) into Builder is a one-time checklist run by you, optionally automated by an outside agent (Patch). Builder cannot bootstrap her own access — chicken-and-egg: she would need write access to configure the rule that grants her write access. The checklist lives at `docs/builder-onboarding.md` and covers GitHub App install + 1Password item + branch-protection allowlist update + agent-side template / tool wiring + per-agent config.

### D17. Operator-identity canonical key: email

The per-agent operator allowlist is a flat list of email addresses. For dispatching agents whose channel naturally produces email identities (Gmail, etc.), the From: address is used directly. For Slack-channel dispatching agents, the dispatching agent does a `users.info` lookup with the `users:read.email` scope to resolve the Slack `user_id` → email before sending the dispatch. Builder treats `senderEmail` as an email string for re-verification against the allowlist.

- Rationale: keeps the allowlist a flat list (operationally trivial), single identity model across channels, single Slack API call per dispatch is invisible at expected volumes (operator-initiated, low-frequency).
- Alternative considered: per-operator records with multiple identity bindings (email + Slack user_id + etc.) — rejected as premature; can be added later if the operator set grows large.

### D18. Reply-context persistence: dispatching-agent-side Redis hash

The dispatching agent persists `{jobId → replyContext + resume metadata}` in a Redis hash with a 24-hour TTL, keyed by `jobId`. Stored on the original dispatch, read on every callback, cleared on terminal state (`testable` or `failed`).

- Rationale: conversations are state; pretending otherwise is architectural cosplay. The CPS-style "embed continuation in the message" pattern only fully escapes server-side state when the message envelope is a first-class typed protocol — Slack and email aren't that. A 1KB Redis entry with TTL is the cheapest possible store and the most debuggable (`redis-cli HGET`).
- Alternative considered: continuation-token-in-message (CPS-style) — elegant in theory, but the channel boundary always needs at least a `thread_ts → token` map in practice, which is functionally equivalent to a Redis hash.
- Alternative considered: branch-side commit of `.builder/reply-context.json` — half-measure, since the dispatching agent still needs `{thread_ts → branch}` to fire the resume.

### D19. Default branch-naming convention

When an agent doesn't declare its own `branch_naming_pattern`, Builder uses `builder/<kebab-case-summary>`. Agents whose repos enforce a structured naming pattern (e.g., `{type}/{TICKET-ID}-{description}`) declare their override per-agent in `AGENTS_CONFIG`.

## Risks / Trade-offs

- **[Operator-allowlist drift]** → Per-agent configuration owns the list; rotation requires deploys. Mitigation: keep small, review on operator changes.
- **[Builder stuck without `failed`]** → Wall-clock timeout watchdog in BullMQ; on timeout the runner emits a synthetic `failed` callback. Without this, the `failed` state exists in the contract but the operator still strands.
- **[Reply-context loss during pause/resume]** → The envelope must be reattached on resume dispatch. Mitigation: dispatching agent persists `{jobId → replyContext}` for the conversation window; alternative is for Builder to commit it to her branch (acceptable but slightly leaky — context contains channel IDs).
- **[Restart on every Builder dispatch]** → Option 1 means each merge bounces clawndom. Mitigation: graceful shutdown in the supervisor; consider hot-reload (option 3) as a follow-on if restart cost becomes painful.
- **[Per-repo credentials leak]** → 1Password rotation per repo; the App's installation on the affected repo can be revoked without touching others. Per-tenant blast radius.
- **[Bot-allowlist administration]** → Each repo's allowlist must stay in sync with the bots that legitimately author PRs (Builder + Patch + Scarlett + any future bots). Mitigation: document in the onboarding recipe; review on bot additions/rotations.
- **[Plan-as-markdown drift across runs]** → Builder commits the plan early; on resume she reads then updates it. Convention is enforced by her system prompt; if she forgets, resume is degraded but not corrupt.
- **[Idempotency window]** → Callback dedupe needs a TTL longer than any plausible Builder run; default 24h.
- **[Shared Builder queue head-of-line blocking]** → One slow Builder job delays others. Mitigation: monitor; partition by repo if it becomes a problem.

## Migration Plan

1. Land clawndom infrastructure (internal-bearer strategy, dispatch route, queue, runner, callback route, idempotency, per-agent config schema additions, Builder agent definition) behind a feature flag.
2. Choose the first opt-in agent and its repo. Run the per-agent-repo onboarding checklist: provision Builder GitHub App, install on the repo, store credentials in 1Password, update the repo's branch-protection approved-bot allowlist to include the new Builder bot (without removing existing legitimate bots), and configure per-agent fields in `AGENTS_CONFIG` (`builder_bot_ref`, `branch_naming_pattern`, `operator_allowlist` (empty initially), `testable_mechanism: "deploy_webhook"`, supervisor webhook URL).
3. Add the `dispatch_to_builder` tool to the agent's tool registry; add the privileged-route template variant; update tool-grant config so the tool is loaded only on the privileged route.
4. Configure the supervisor (PM2 / systemd / k8s) to call clawndom's deploy-webhook endpoint after each successful clawndom restart, with the affected `jobId`.
5. Smoke-test by adding a single operator to the agent's allowlist and dispatching a no-op improvement; verify PR opens authored by Builder's bot, restart happens, `testable` callback fires, and the operator sees the reply.
6. Roll out additional agents/repos one at a time.

Rollback per agent: empty that agent's allowlist. Global rollback: disable Builder's queue worker.

## Open Questions

None at this time. All previously-open configuration questions are resolved in Decisions D17 (operator-identity = email), D18 (reply-context = dispatching-agent-side Redis hash), and D19 (default branch-naming = `builder/<kebab-summary>`).
