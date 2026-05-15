## ADDED Requirements

### Requirement: Builder Scope — Dispatching Agent's Directory Only

Builder MUST handle only add / change / delete requests scoped to **the dispatching agent's directory** within its repo. The dispatching agent is identified by `agentName` in the dispatch payload; Builder's runner MUST resolve the agent's repo and `path` from `AGENTS_CONFIG`. Builder's modifications MUST be limited to files under that `path`.

Builder MUST NOT:

- Modify files outside the dispatching agent's `path` (including other colocated agents' directories)
- Modify any `sharedTools` directory (pinned by ref in the agent's config; changes require a separate coordinated PR plus a `clawndom.yaml` ref bump)
- Modify clawndom itself
- Modify any agent-repo other than the dispatching agent's

If a dispatched request requires changes outside Builder's scope, she MUST emit a `failed` callback whose reason names the out-of-scope change and MUST NOT make any modification.

#### Scenario: Modification outside dispatching agent's path

- **GIVEN** the dispatching agent's `path` is `agents/winston/` in its repo
- **WHEN** Builder's plan would modify a file outside `agents/winston/`
- **THEN** Builder MUST refuse the change and emit `failed` with a reason naming the out-of-path file

#### Scenario: Out-of-scope — sibling colocated agent

- **GIVEN** agent `A` (path `agents/winston/`) dispatches a request that would require changes to agent `B` (path `agents/heather-helper/`) in the same repo
- **WHEN** Builder analyzes the request
- **THEN** Builder MUST emit `failed` with a reason naming the cross-agent requirement

#### Scenario: Out-of-scope — shared tools

- **GIVEN** a dispatch would require changes to the agent's `sharedTools` directory
- **WHEN** Builder analyzes the request
- **THEN** Builder MUST emit `failed` with a reason naming the shared-tools constraint (pinned by ref; requires separate coordinated change)

#### Scenario: Out-of-scope — clawndom

- **GIVEN** a dispatch would require modifying clawndom infrastructure
- **WHEN** Builder analyzes the request
- **THEN** Builder MUST emit `failed` with a reason naming clawndom as out-of-scope

### Requirement: Builder Definition Location

Builder's agent definition MUST live at `clawndom/src/system-agents/builder/` as a single shared definition used by every dispatch. The directory MUST contain at minimum:

- A system prompt encoding the what-goes-where taxonomy, the repo hygiene rules, and the scope discipline
- A plan-markdown template Builder fills out and commits to her working branch
- A tool list scoped to repo operations only (clone, fetch, branch, edit, commit, push, open PR, run check-all, delete remote branch); no Slack/Gmail/user-channel tools

#### Scenario: Builder definition exists in clawndom

- **WHEN** the clawndom repo is inspected after this change is implemented
- **THEN** `src/system-agents/builder/` MUST exist
- **AND** it MUST contain a system prompt file, a plan template file, and a tool list

#### Scenario: Builder not in AGENTS_CONFIG

- **WHEN** clawndom's `AGENTS_CONFIG` is inspected
- **THEN** Builder MUST NOT appear as an entry

### Requirement: Builder Dispatch Route

clawndom MUST expose `POST /webhooks/system/builder` that:

- Validates the internal-bearer token using the strategy defined in the `system-agents` capability
- Validates the dispatch payload against a Zod schema requiring `{agentName: string, request: string, replyContext: object, senderEmail: string}` and optionally `{resume: {branch: string, answer: string}}`
- Resolves the dispatching agent from `AGENTS_CONFIG` by `agentName` (returns 404 if unknown)
- Re-verifies `senderEmail` against the dispatching agent's operator allowlist (returns 403 if not allowed)
- Enqueues a Builder job to her dedicated BullMQ queue with the dispatching agent's context preserved
- Returns 202 immediately on success, before Builder begins execution

#### Scenario: Valid dispatch

- **WHEN** a POST arrives with valid bearer, valid payload, known `agentName`, and an allowlisted `senderEmail` for that agent
- **THEN** the route MUST enqueue a Builder job
- **AND** the route MUST respond 202

#### Scenario: Unknown agent

- **WHEN** a dispatch arrives with an `agentName` not present in `AGENTS_CONFIG`
- **THEN** the route MUST respond 404
- **AND** no Builder job MUST be enqueued

#### Scenario: Invalid payload

- **WHEN** a dispatch arrives missing the `replyContext` field
- **THEN** the route MUST respond 400 with a Zod-driven RFC 7807 error body
- **AND** no Builder job MUST be enqueued

#### Scenario: Sender not allowlisted for agent

- **WHEN** a dispatch arrives with valid bearer and known `agentName` but a `senderEmail` not on that agent's allowlist
- **THEN** the route MUST respond 403
- **AND** no Builder job MUST be enqueued

### Requirement: Builder Queue and Runner

Builder MUST run on her own dedicated BullMQ queue with her own runner registration in `src/services/` and `src/runners/`. The runner MUST process Builder's queue under the existing completion-aware serialization gate. At job-pickup time, the runner MUST resolve the dispatching agent's context (repo, `path`, Builder bot credentials reference for that repo, branch-naming convention, `testableMechanism`, operator allowlist) and fail closed via a `failed` callback if any required configuration or credential cannot be fetched.

#### Scenario: Dedicated queue

- **WHEN** the clawndom service starts with at least one opt-in agent
- **THEN** a BullMQ queue named `builder` MUST exist
- **AND** Builder's runner MUST be registered to process that queue

#### Scenario: Dispatching-agent context resolved at job pickup

- **WHEN** Builder's runner picks up a job with `agentName = A`
- **THEN** the runner MUST fetch `A`'s entry from `AGENTS_CONFIG`
- **AND** if `A` is missing or has not been onboarded to Builder, the runner MUST emit a `failed` callback whose reason names the missing context

### Requirement: Builder Lifecycle States

Builder's job execution MUST emit callbacks for the following states and only these states:

- `working` — emitted immediately on job pickup
- `question_pending` — emitted when Builder needs operator input; the job ends and the callback carries `{question: string, branch: string, planPath: string}`
- `testable` — emitted when the resulting change is live for the dispatching agent per that agent's declared `testableMechanism`; the callback carries `{prUrl: string, testUrl?: string}`
- `failed` — emitted when Builder cannot proceed; the callback carries `{reason: string}`

Each transition MUST be a POST to `/webhooks/builder-callback` with `eventId` of the form `<jobId>:<state_name>`.

#### Scenario: Working callback on pickup

- **WHEN** Builder's runner picks up a dispatched job
- **THEN** the runner MUST POST a callback with `state: "working"` and `eventId: "<jobId>:working"` before beginning work

#### Scenario: Question-pending callback

- **WHEN** Builder determines she needs operator clarification
- **THEN** Builder MUST commit the current plan markdown to her working branch
- **AND** the job MUST end with a callback carrying `state: "question_pending"` and `{question, branch, planPath}`

#### Scenario: Testable via deploy webhook

- **GIVEN** the dispatching agent's `testableMechanism` is `deploy_webhook`
- **WHEN** the supervisor has restarted clawndom after Builder's PR merge and posts to the deploy-complete webhook with the affected `jobId`
- **THEN** Builder's callback handler MUST emit `testable` to the dispatching agent

#### Scenario: Testable via cache refresh

- **GIVEN** the dispatching agent's `testableMechanism` is `cache_refresh`
- **WHEN** Builder's PR is merged
- **THEN** a callback MUST be emitted with `state: "testable"`

#### Scenario: Testable via PR preview

- **GIVEN** the dispatching agent's `testableMechanism` is `pr_preview`
- **WHEN** the preview environment for Builder's PR is ready
- **THEN** a callback MUST be emitted with `state: "testable"` carrying the preview URL as `testUrl`

#### Scenario: Failed callback on irrecoverable error

- **WHEN** Builder encounters an irrecoverable error (timeout, refused scope, repeated CI failure)
- **THEN** a callback MUST be emitted with `state: "failed"` and a human-readable `reason`
- **AND** silent failure (no callback at all) MUST NOT occur

#### Scenario: Watchdog timeout produces failed

- **GIVEN** a Builder job exceeds its configured wall-clock timeout
- **WHEN** the BullMQ watchdog fires
- **THEN** the runner MUST emit a synthetic `failed` callback whose reason names the timeout

### Requirement: Restart-Driven Testable via Deploy Webhook

For agents whose `testableMechanism` is `deploy_webhook` (the v1 default for clawndom-resident agents), clawndom MUST expose `POST /webhooks/builder-deploy-complete` that:

- Validates an internal-bearer token (the same strategy used for dispatch)
- Validates the payload against a Zod schema requiring `{jobId: string, status: "ok"|"failed"}`
- Looks up the original job by `jobId`
- Emits a `testable` callback (or `failed`, if `status: "failed"`) to the dispatching agent
- Returns 202

The external supervisor (PM2 / systemd / k8s) MUST be configured to POST to this endpoint after a successful clawndom restart, supplying the `jobId` from the most recently merged Builder PR. The supervisor's configuration is outside clawndom; this requirement specifies only the endpoint contract.

#### Scenario: Successful deploy emits testable

- **GIVEN** Builder's PR for `jobId = J` was merged and clawndom restarted successfully
- **WHEN** the supervisor POSTs `{jobId: J, status: "ok"}` to the deploy-complete webhook
- **THEN** clawndom MUST emit a `testable` callback for job `J` to the dispatching agent

#### Scenario: Failed deploy emits failed

- **GIVEN** Builder's PR for `jobId = J` was merged but clawndom failed to restart
- **WHEN** the supervisor POSTs `{jobId: J, status: "failed"}` to the deploy-complete webhook
- **THEN** clawndom MUST emit a `failed` callback for job `J` whose reason names the restart failure

### Requirement: Builder Callback Route

clawndom MUST expose `POST /webhooks/builder-callback` that:

- Validates the internal-bearer token
- Validates the callback payload against a Zod schema requiring `{eventId: string, state: "working"|"question_pending"|"testable"|"failed", replyContext: object, ...state-specific fields}`
- Dedupes by `eventId` against a Redis-backed store with a TTL of at least 24 hours
- Hands the callback to a handler that triggers the operator-reply via the dispatching agent's outbound channel
- Returns 202 in all dedupe-and-validation success cases, including duplicate deliveries

#### Scenario: Duplicate callback delivery

- **GIVEN** a callback with `eventId E` has already been processed and recorded in Redis
- **WHEN** a second callback arrives with the same `eventId E`
- **THEN** the route MUST return 202
- **AND** no second operator-facing reply MUST be triggered

#### Scenario: Callback for unknown job

- **WHEN** a callback arrives whose `eventId` does not match any known Builder job
- **THEN** the route MUST log a warning
- **AND** MUST still return 202

### Requirement: Reply-Context Envelope Passthrough

The `replyContext` field of a Builder dispatch payload MUST be treated as opaque by Builder. Builder MUST NOT inspect, alter, or log (beyond a hash or identifier) the envelope's contents. Every callback Builder emits MUST include the envelope byte-identical to the value received in the original dispatch (or, on resume, in the resume dispatch).

The envelope's schema MUST contain at minimum:

- `channel` — `"slack"` | `"email"` | other extensible value
- `threadOrMessageId` — channel-specific reference
- `senderEmail` — operator identity
- `originalRequestText` — the user's original message

#### Scenario: Envelope passthrough

- **GIVEN** a dispatch payload with `replyContext = X`
- **WHEN** Builder emits any callback for that job
- **THEN** the callback's `replyContext` MUST equal `X` byte-identical

#### Scenario: Envelope not exposed in logs

- **WHEN** Builder's structured logs are inspected for any invocation
- **THEN** the logs MUST NOT contain the contents of `replyContext` beyond a hash or identifier

### Requirement: Git-Native Pause and Resume

When Builder emits `question_pending`, she MUST persist her in-progress plan as a markdown file committed to her working branch (default path: `.builder/plan.md` under the dispatching agent's `path`). The plan MUST be sufficient for a future Builder invocation to continue from where she paused without external state.

A resume dispatch MUST carry only `{agentName, request, replyContext, senderEmail, resume: {branch: string, answer: string}}`. Builder MUST re-hydrate by checking out the named branch and reading the plan file.

#### Scenario: Pause commits plan

- **WHEN** Builder emits `question_pending`
- **THEN** the named branch MUST contain a committed `.builder/plan.md` at the path reported in `planPath`

#### Scenario: Resume re-hydrates from branch

- **GIVEN** Builder previously paused on branch `B` for dispatching agent `A` with plan at `.builder/plan.md`
- **WHEN** a resume dispatch arrives carrying `{agentName: A, resume: {branch: B, answer: ANS}}`
- **THEN** Builder MUST check out `B` in `A`'s repo
- **AND** Builder MUST read the plan from `.builder/plan.md`
- **AND** Builder MUST continue execution using `ANS` as the answer to the pending question

#### Scenario: No external resume store

- **WHEN** Builder is resumed
- **THEN** no Redis hash, database row, or other external store of resume-token state MUST be required

### Requirement: Repo Hygiene

Builder MUST follow standard engineering hygiene when working in the dispatching agent's repo:

- Before starting a fresh (non-resume) job, Builder MUST fetch and reset to the latest `origin/main` so her working branch is created from current state.
- Builder MUST create a working branch following the dispatching agent's configured branch-naming convention (default: `builder/<kebab-case-summary>` when no override is configured). Direct commits or pushes to `main` MUST NOT be attempted.
- On resume, Builder MUST check out the named branch and preserve her prior commits; she MUST NOT force-push or rebase away her own paused-work commits without explicit operator instruction.
- Before opening a pull request, Builder MUST run the dispatching agent's verification command (`make check-all` or the agent's configured equivalent) and MUST NOT open a PR with known failures.
- Builder MUST NOT bypass pre-commit hooks (`--no-verify`), MUST NOT bypass signing flags (`--no-gpg-sign`), and MUST NOT otherwise circumvent the repo's commit-time gates.
- Builder MUST NOT commit secrets, credentials, large binaries, or files matching the repo's `.gitignore`.
- Builder MUST use the commit-message style enforced by the repo (e.g., Conventional Commits) when one is configured.
- After a terminal state, Builder MUST clean up: working branches that did not merge MUST be deleted from the remote.

#### Scenario: Fresh dispatch starts from origin/main

- **GIVEN** Builder's local checkout of the dispatching agent's repo is behind `origin/main`
- **WHEN** a non-resume dispatch arrives
- **THEN** Builder MUST fetch and reset to `origin/main` before creating her working branch

#### Scenario: Branch naming convention

- **WHEN** Builder creates a working branch
- **THEN** the branch name MUST match the dispatching agent's configured naming convention (or the default when none is configured)

#### Scenario: Resume preserves prior commits

- **GIVEN** Builder paused with WIP commits on branch `B`
- **WHEN** Builder is resumed against `B`
- **THEN** the prior commits on `B` MUST be present after Builder's resume operations
- **AND** Builder MUST NOT force-push or rebase the branch without explicit operator instruction

#### Scenario: check-all must pass before PR

- **WHEN** Builder is ready to open a pull request
- **THEN** she MUST run the dispatching agent's full verification command first
- **AND** if any check fails, she MUST NOT open the PR until the failure is resolved or she emits `failed`

#### Scenario: No hook bypass

- **WHEN** Builder runs `git commit` or `git push`
- **THEN** she MUST NOT use `--no-verify`, `--no-gpg-sign`, or any other hook-bypass flag

#### Scenario: Cleanup after non-merged terminal state

- **GIVEN** Builder reaches `failed`, or her PR is closed without merging
- **WHEN** the terminal callback is emitted
- **THEN** the working branch MUST be deleted from the remote

### Requirement: What-Goes-Where Taxonomy Enforcement

Builder's system prompt MUST encode and Builder's plans MUST enforce the following taxonomy when implementing changes within the dispatching agent's directory:

- **Executable behavior** — a tool definition (NOT inline bash, NOT scripts embedded in templates)
- **Prompt text / user-visible content** — a template
- **Persistent state that crosses invocations** — memory
- **HTTP entry points** — a route + controller + strategy
- **Authorization / signature checks** — a strategy or template rule
- **Business logic** — a service module

When Builder identifies that an improvement requires executable behavior, her plan MUST produce a tool definition and MUST NOT propose embedding the behavior in a template, even when a template edit would be shorter.

#### Scenario: Improvement requiring execution produces a tool

- **GIVEN** an operator asks Builder to add a capability that requires fetching external data at request time
- **WHEN** Builder writes her plan
- **THEN** the plan MUST add a tool definition for the fetch behavior
- **AND** the plan MUST NOT add a bash invocation or script to any template

#### Scenario: Improvement requiring prompt change uses a template

- **GIVEN** an operator asks Builder to change a user-visible message the dispatching agent shows
- **WHEN** Builder writes her plan
- **THEN** the plan MUST edit the relevant template
- **AND** the plan MUST NOT add a tool definition for static text

### Requirement: Builder Identity per Agent-Repo

Builder MUST act under a dedicated GitHub App identity **per opted-in agent-repo**. Each repo's identity (e.g., `the-agency-builder[bot]` for the-agency, or configured equivalent) MUST be installed only on that repo, with credentials stored in 1Password under `Engineering` and fetched at job-pickup time using the dispatching agent's repo (resolved from `AGENTS_CONFIG`). Colocated agents share the same Builder bot for their shared repo. The repo's `main` branch MUST be protected by an approved-bot allowlist (per the `system-agents` spec) that includes this Builder bot among the legitimate authors.

#### Scenario: Per-repo Builder bot

- **WHEN** Builder opens a pull request for dispatching agent `A` in repo `R`
- **THEN** the PR's author MUST be the Builder bot identity provisioned for `R`

#### Scenario: Colocated agents share the Builder bot for their repo

- **GIVEN** agents `A1` and `A2` both live in repo `R`
- **WHEN** Builder is dispatched by either `A1` or `A2`
- **THEN** the Builder bot used MUST be `R`'s Builder bot

#### Scenario: Repo branch protection includes Builder bot

- **GIVEN** repo `R`'s approved-bot allowlist is configured
- **THEN** the allowlist MUST include `R`'s Builder bot
- **AND** the allowlist MAY include any other bots that legitimately author PRs against `R` (e.g., outside agents like Patch or Scarlett)

### Requirement: Builder Does Not Talk to Users Directly

Builder MUST NOT have Slack, Gmail, or any other outbound user-facing tool. All operator-visible communication MUST flow through the dispatching agent via callback events that re-enter the operator's existing channel.

#### Scenario: No user-facing tools

- **WHEN** Builder's tool list is constructed for any invocation
- **THEN** the list MUST NOT include Slack-write, Gmail-send, or any outbound user-channel tool

#### Scenario: All user replies via dispatching agent

- **WHEN** the dispatching agent processes a callback from Builder
- **THEN** that agent (using the echoed `replyContext`) MUST be the one that actually sends the reply to the operator's original channel
