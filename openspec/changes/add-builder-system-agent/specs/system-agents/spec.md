## ADDED Requirements

### Requirement: System Agent Category Definition

A **system agent** is an agent that modifies one or more *other* agents' definitions on behalf of an operator-authenticated dispatch. A system agent's definition (system prompt, tool list, plan template, pattern-enforcement rules) MUST live in clawndom under `src/system-agents/<agent-name>/` and MUST NOT live in any agent repo loaded via `AGENTS_CONFIG`. The path is deliberately `system-agents/` (not `agents/`) to avoid name collision with the external-agent loading path. The category is distinguished from ordinary agents by **who can reach it**: system agents MUST be reachable only through authenticated operator paths and MUST NOT have any tool-call path that civilians can invoke directly or transitively.

#### Scenario: System agent code location

- **WHEN** a system agent named `builder` is introduced
- **THEN** its definition MUST exist at `clawndom/src/system-agents/builder/`
- **AND** it MUST NOT exist as an entry in `AGENTS_CONFIG`

#### Scenario: No civilian path to system agent

- **GIVEN** an ordinary agent invocation on a civilian-facing route (e.g., public email or public Slack channel)
- **WHEN** the agent's tool list is constructed for that invocation
- **THEN** no `dispatch_to_<system_agent>` tool MUST be present in the toolset

### Requirement: Tool-Presence as Primary Defense

The structural defense against unauthorized dispatch to a system agent MUST be the *absence* of the corresponding `dispatch_to_<system_agent>` tool from an ordinary agent's tool list on non-privileged routes. Prompt-level rules and runtime allowlist checks MUST exist as defense-in-depth but MUST NOT be relied on as the primary gate.

#### Scenario: Privileged-route tool inclusion

- **GIVEN** an ordinary agent is invoked on a privileged route configured to dispatch to a system agent
- **THEN** the corresponding `dispatch_to_<system_agent>` tool MUST be loaded into the agent's tool list

#### Scenario: Non-privileged route tool exclusion

- **GIVEN** an ordinary agent is invoked on any route that is not explicitly configured as a privileged dispatch route for a given system agent
- **THEN** the corresponding `dispatch_to_<system_agent>` tool MUST NOT be loaded

### Requirement: Internal-Bearer Authentication for System Agent Dispatch

System agent dispatch routes MUST validate an `Authorization: Bearer <token>` header against a value held in the platform's secret store. The validation MUST use timing-safe comparison via `crypto.timingSafeEqual`. Invalid or missing tokens MUST result in a 401 response with an RFC 7807-compliant error body. The internal-bearer strategy MUST be implemented as a pluggable signature-validation strategy in `src/strategies/` alongside existing strategies (`websub`, `github`, etc.).

#### Scenario: Missing bearer

- **WHEN** a POST to a system agent dispatch route arrives without an `Authorization` header
- **THEN** the route MUST respond 401 with an RFC 7807 error body

#### Scenario: Invalid bearer

- **GIVEN** a POST with `Authorization: Bearer wrong-token`
- **WHEN** the route processes the request
- **THEN** the route MUST respond 401
- **AND** the token comparison MUST use timing-safe comparison

#### Scenario: Valid bearer

- **GIVEN** a POST with a correctly-signed `Authorization: Bearer <valid-token>` header
- **WHEN** the route processes the request
- **THEN** the route MUST proceed to payload validation

### Requirement: Operator Allowlist Enforcement

Every privileged dispatch route MUST resolve the dispatching operator's identity (signed sender email, Slack user ID, or equivalent) and MUST refuse the dispatch if the identity is not present in the **dispatching agent's** configured operator allowlist. Each ordinary agent that opts into dispatching to a system agent MUST have its own allowlist (scoped per-agent, not per-repo). The check MUST be enforced in two places:

1. **Dispatching agent template (Layer 2):** the privileged-route template MUST instruct the agent to refuse to call `dispatch_to_<system_agent>` if sender identity is not in the agent's allowlist.
2. **System agent receipt (Layer 3):** the system agent MUST re-verify the claimed sender identity against the dispatching agent's allowlist on dispatch receipt and reject with 403 if not present.

Each agent's allowlist MUST be loaded from configuration at startup and MUST be validated with Zod. An empty allowlist MUST be valid configuration and MUST cause all dispatches from that agent to be refused.

#### Scenario: Identity not on allowlist — dispatching agent refuses

- **GIVEN** dispatching agent `A`'s operator allowlist does not contain sender identity `S`
- **WHEN** a request from `S` arrives on `A`'s privileged route
- **THEN** `A`'s template MUST instruct refusal of the dispatch
- **AND** `A` MUST respond to `S` with a refusal message rather than calling the dispatch tool

#### Scenario: Identity not on allowlist — system agent rejects

- **GIVEN** a dispatch payload arrives at a system agent route claiming to come from dispatching agent `A` with sender identity `S` that is not in `A`'s allowlist
- **WHEN** the system agent processes the dispatch
- **THEN** the route MUST respond 403 regardless of whether `A` allowed the dispatch

#### Scenario: Empty allowlist

- **GIVEN** dispatching agent `A`'s operator allowlist is empty
- **WHEN** any dispatch arrives at the privileged route configured for `A`
- **THEN** every dispatch MUST be refused

### Requirement: Per-Agent-Repo Credentials Boundary

A system agent that targets multiple agent-repos MUST have a dedicated identity (GitHub App or equivalent) **per agent-repo it targets**. Credentials for each repo's identity MUST be stored in the platform's secret store (1Password under `Engineering`) and fetched at job-pickup time by the runner using the dispatching agent's repo (resolved from `AGENTS_CONFIG` via the dispatching agent's `name`). Agents colocated in the same repo MUST share the same system agent identity for that repo; the dispatching-agent-name is used to scope modifications, not to select credentials.

#### Scenario: Per-repo credential selection

- **GIVEN** agents `A1` and `A2` both live in repo `R`, and agent `A3` lives in repo `R2`
- **WHEN** a job is dispatched from `A1`
- **THEN** the runner MUST fetch the system agent's credentials for `R` (the same credentials it would fetch for an `A2` dispatch)
- **AND** the runner MUST NOT fetch the credentials for `R2`

#### Scenario: Credentials fetch fails closed

- **WHEN** a system agent runner picks up a job and cannot fetch the dispatching agent's repo credentials from the secret store
- **THEN** the runner MUST refuse to begin the job
- **AND** the runner MUST emit a `failed` callback whose reason names the missing credential

### Requirement: Approved-Bot Allowlist Branch Protection

For each agent-repo that a system agent targets, the `main` branch MUST be protected by an **approved-bot allowlist** that includes the system agent's bot for that repo plus any other bots that legitimately author PRs against that repo (e.g., outside agents like Patch or Scarlett that already write to the repo). PRs whose author is not in the allowlist MUST be rejected at merge time. The allowlist MUST be configured manually per-repo during onboarding; it is NOT automatically managed by the system agent.

#### Scenario: Approved bot can author

- **GIVEN** repo `R`'s `main` branch protection allowlist is `{builder-bot-R, patch-bot, scarlett-bot}`
- **WHEN** any of those bots opens a PR against `R`'s `main`
- **THEN** branch protection MUST permit the PR to merge (subject to other gates like reviews and CI)

#### Scenario: Unknown identity rejected

- **GIVEN** repo `R`'s approved-bot allowlist does not include identity `X`
- **WHEN** a PR opened by `X` attempts to merge into `R`'s `main`
- **THEN** branch protection MUST reject the merge

### Requirement: Filesystem Boundary for Non-System Agents

Every agent that is not a system agent (i.e., every ordinary agent loaded via `AGENTS_CONFIG`) MUST run in an environment satisfying all of:

- The agent's tool list MUST NOT include any filesystem-write tool (no `Edit`, `Write`, no `Bash` configuration that permits redirection or in-place edits against source paths).
- The source tree MUST be mounted read-only at the operating-system level.
- Each invocation MUST start from a freshly-prepared checkout, so any in-flight tampering cannot persist across invocations.

#### Scenario: Read-only source mount

- **GIVEN** an ordinary agent is invoked and its execution environment is constructed
- **WHEN** any process within that environment attempts to write to a source-tree path
- **THEN** the write MUST fail with an OS-level permission error

#### Scenario: No filesystem-write tools

- **WHEN** an ordinary agent's tool list is constructed for any invocation
- **THEN** the list MUST NOT contain any tool capable of writing to the source tree

#### Scenario: Fresh checkout per invocation

- **WHEN** an ordinary agent is invoked
- **THEN** the checkout used MUST be freshly prepared
- **AND** any modifications made to files during a previous invocation MUST NOT be present

### Requirement: Defense in Depth — CI Re-Verification of Auto-Merge Verdict

**Shipped (PR #136, commit `0be1892`).** When a system agent self-classifies whether its own diff is safe to auto-merge (today: Builder via the `autoMergeEligible` field on the `testable` callback — see `builder-agent` spec, "Builder Self-Classifies Auto-Merge Eligibility"), that classification MUST NOT be the sole gate on the eventual `git merge`. A compromised system-agent runtime could lie on the callback and then `gh pr merge` a structural change.

The shipped defense is a **reusable GitHub Actions workflow** at `.github/workflows/builder-auto-merge-gate.yml` in this clawndom repo. Each workspace repo opted into Builder MUST:

1. Add a caller workflow (e.g., `.github/workflows/builder-gate.yml` per the example in the reusable workflow's docstring) that delegates to `SC0RED/clawndom/.github/workflows/builder-auto-merge-gate.yml@main` on every PR opened by the system agent's bot identity (e.g., `sc0red-patch[bot]`).
2. Register the resulting check as a **required status check** on the repo's `main` branch protection.

The workflow:

- Computes `git diff --name-status` between PR base and head.
- Fails the check if any line is anything other than `M` (no `A` / `D` / `R` / `C`) OR if any modified path falls outside the system agent's published auto-merge allowlist.
- Routes the caller-supplied `workspace-root` input through an environment variable to avoid shell-injection (`githubactions:S7630`).

Because the check is a required status check, `gh pr merge` issued by the system agent's bot identity MUST fail when the gate disagrees with the agent's verdict. Branch protection blocks the structural change from reaching `main` regardless of what the system-agent runtime tried to do — including the case where the runtime is fully compromised by prompt injection.

The allowlist embedded in the workflow MUST be kept in lockstep with the allowlist in the system agent's prompt (today: `src/system-agents/builder/prompt.md`, "Auto-merge gate"). Both files MUST cite each other as the canonical pair so changes to one trigger review of the other.

When the gate's classification diverges from the system agent's verdict, the divergence is itself a signal worth surfacing — the system agent SHOULD emit a `failed` callback whose reason names the gate failure, so the operator and the reviewer learn about the disagreement immediately.

#### Scenario: Workspace repo opts in via caller workflow

- **GIVEN** a workspace repo `R` has been onboarded to Builder
- **WHEN** Builder opens a PR in `R` from her bot identity
- **THEN** the caller workflow MUST delegate to clawndom's reusable workflow with the configured `workspace-root`
- **AND** the resulting status check MUST be required on `R`'s `main` branch protection

#### Scenario: Compromised runtime cannot launder a structural change

- **GIVEN** Builder's runtime fires `testable` with `autoMergeEligible: true` on a PR whose diff includes a new file
- **WHEN** Builder runs `gh pr merge <pr-number> --squash --delete-branch`
- **THEN** the merge MUST fail because the required CI gate fails on the `A` line in the diff
- **AND** the structural change MUST NOT reach `main`

#### Scenario: Cosmetic diff passes both gates

- **GIVEN** Builder's diff is a single `M` line on `<workspace-root>/<agent>/templates/foo.md`
- **WHEN** the gate workflow runs
- **THEN** the check MUST pass
- **AND** `gh pr merge` MUST succeed

#### Scenario: Empty diff fails the gate

- **GIVEN** Builder opens a PR whose diff is empty
- **WHEN** the gate workflow runs
- **THEN** the check MUST fail (a PR that does nothing is never auto-merge-eligible)

#### Scenario: Allowlist drift between workflow and prompt

- **WHEN** the allowlist in `src/system-agents/builder/prompt.md` is changed
- **THEN** the corresponding patterns in `.github/workflows/builder-auto-merge-gate.yml` MUST be updated in the same change (and vice versa); the two files MUST stay in lockstep

### Requirement: No-Blocking-Calls Dispatch Contract

Every HTTP hop in any system agent's dispatch and callback lifecycle MUST return within seconds with a 202 status. No hop MUST hold an open connection waiting for the system agent's job to complete. Long-running execution MUST occur in BullMQ; reply to the operator MUST occur via a short outbound API call triggered by a callback, not by long-polling.

#### Scenario: Dispatch returns 202 quickly

- **WHEN** a valid dispatch arrives at a system agent dispatch route
- **THEN** the route MUST respond 202 within 1 second under nominal load
- **AND** the response MUST occur before the system agent's job execution completes

#### Scenario: Callback returns 202 quickly

- **WHEN** a valid callback arrives at a system agent callback route
- **THEN** the route MUST respond 202 within 1 second under nominal load
