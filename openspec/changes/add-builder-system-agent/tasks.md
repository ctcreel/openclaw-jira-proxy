## 1. Locked Configuration Decisions

These are baked into the spec (design D17–D19); the tasks here exist so an implementer reviews and confirms before proceeding.

- [x] 1.1 Confirm canonical operator-identity key is **email**; Slack-channel dispatching agents resolve `user_id` → email via `users.info` (`users:read.email` scope) before dispatching; allowlist is a flat list of email strings per agent.
- [x] 1.2 Confirm reply-context persistence is a **dispatching-agent-side Redis hash** keyed by `job_id` with a 24-hour TTL, stored on dispatch, read on callback, cleared on terminal state.
- [x] 1.3 Confirm default branch-naming convention is **`builder/<kebab-summary>`**; agents may override via `branch_naming_pattern` in `AGENTS_CONFIG`.

## 2. Per-Agent Configuration Schema Extensions

- [x] 2.1 Extend `agentEntrySchema` in `src/config.ts` via `.merge(builderAgentFieldsSchema)`; new optional fields live in `src/system-agents/builder/agent-config.ts`: `builderBotRef`, `branchNamingPattern?`, `operatorAllowlist`, `testableMechanism` (tagged union of `deploy_webhook + {webhookUrl}`, `cache_refresh`, `pr_preview + {previewResolver}`).
- [x] 2.2 Validate at startup via `validateBuilderAgentSecrets` wired into `server.ts` after `loadAgents`: for any opted-in agent (one declaring `builderBotRef`), confirm the secret key resolves in `SecretManager` and enforce the cross-field rule that opt-in requires the full triple `{builderBotRef, operatorAllowlist, testableMechanism}`; fail-fast with a single aggregated error otherwise.
- [x] 2.3 Opt-in is signaled by the *presence* of `builderBotRef`; an opted-in agent must declare `operatorAllowlist` explicitly (no implicit default), which an operator can set to an empty array to refuse all dispatches while keeping the agent technically opted in.
- [x] 2.4 Added Zod schemas `builderDispatchPayloadSchema` and `builderCallbackPayloadSchema` in `src/system-agents/builder/payloads.ts`; dispatch uses `.strict()` to reject unknown fields; callback uses `z.discriminatedUnion('state', ...)` so each state's required extras are typed.
- [x] 2.5 Added `replyContextEnvelopeSchema` as a `z.discriminatedUnion('channel', ...)` with `slack` and `email` variants in `src/system-agents/builder/payloads.ts`.
- [x] 2.6 Added `builderDeployCompletePayloadSchema` (`{jobId, status, reason?}`) in `src/system-agents/builder/payloads.ts`.

## 3. Internal-Bearer Strategy and Shared Secret

The existing `bearer` strategy in `src/strategies/signature.ts` (originally added for Google Pub/Sub push endpoints) already validates `Authorization: Bearer <token>` with `crypto.timingSafeEqual` and is registered in the strategy registry. Reuse it for Builder dispatch; no new strategy file is needed.

- [ ] 3.1 Generate and store the internal-bearer token (`BUILDER_INTERNAL_BEARER`) in 1Password under `Engineering`; ensure the same secret is reachable by clawndom and every opted-in agent's runtime. (Operational; performed during provisioning, see section 10.)
- [x] 3.2 Reuse `bearerStrategy` from `src/strategies/signature.ts`; route configuration for `POST /webhooks/system/builder` (section 6) declares `signatureStrategy: 'bearer'` and references the `BUILDER_INTERNAL_BEARER` secret as `hmacSecret`.
- [x] 3.3 The strategy is already registered in `getSignatureStrategy` (`src/strategies/signature.ts`); no additional registration needed.
- [x] 3.4 Existing tests in `tests/strategies/signature.test.ts` cover the bearer strategy under the four required cases (missing header, malformed header, wrong token / timing-safe, correct token). No additional tests required for the strategy itself; route-level integration tests for the dispatch path land in section 6.

## 4. Builder Agent Definition

- [x] 4.1 Created `src/system-agents/builder/prompt.md` encoding scope discipline, the what-goes-where taxonomy, the lifecycle contract, pause/resume semantics, repo hygiene (4.4), and the plan-template reference. Tests in `tests/system-agents/builder/prompt.test.ts` assert each named requirement is present in the prompt text.
- [x] 4.2 Created `src/system-agents/builder/plan-template.md` with the required sections (goal, scope assertion, plan, open questions, current step, decisions log) and per-section HTML-comment guidance.
- [x] 4.3 Created `src/system-agents/builder/tools.ts` exporting `BUILDER_TOOLS` (clone_repo, fetch_origin, create_branch, read_file, edit_file, write_file, commit, push, open_pr, delete_remote_branch, run_check_all), plus a `FORBIDDEN_BUILDER_TOOLS` denylist (Slack/Gmail/email/webhook outbound) and an `isForbiddenBuilderTool` predicate.
- [x] 4.4 Encoded the eight repo-hygiene rules in `prompt.md`: fresh start (fetch + reset to `origin/main`); branch-naming with `branchNamingPattern` override and `builder/<kebab-case-summary>` default; resume preserves prior commits / no force-push without operator instruction; run `make check-all` (or configured equivalent) before opening a PR; no hook-bypass flags; no secret or large-binary commits; commit-message style match (Conventional Commits when configured); cleanup of unmerged branches on terminal state.
- [x] 4.5 `tests/system-agents/builder/tools.test.ts` asserts `BUILDER_TOOLS` contains exactly the eleven allowed repo-modification tools, that no name matches `/slack/`, `/gmail|email_send|mail_send/`, or `/webhook/`, and that `FORBIDDEN_BUILDER_TOOLS` covers the major user-channel verbs.
- [x] 4.6 `tests/system-agents/builder/prompt.test.ts` runs 14 assertions over the prompt file, one per scope/taxonomy/lifecycle/hygiene rule named in the spec.

## 5. Builder Queue and Runner

- [ ] 5.1 Define a BullMQ queue `builder` with the existing completion-aware serialization gate; one queue across all dispatches in v1.
- [ ] 5.2 Implement `src/runners/builder-runner.ts` implementing the `AgentRunner` interface. On job pickup, the runner MUST resolve the dispatching agent from `AGENTS_CONFIG` by `agent_name`, fetch the dispatching agent's Builder bot credentials for its repo, and fail closed via a `failed` callback if the agent is missing or has not been onboarded to Builder.
- [ ] 5.3 The runner MUST enforce Builder's path-scoped modifications: before committing any file change, assert the path begins with the dispatching agent's configured `path`; emit `failed` with a path-violation reason if not.
- [ ] 5.4 Implement the runner's lifecycle: emit `working` callback on pickup, run Builder's agent loop, intercept question/done/error to emit `question_pending` / `testable` / `failed` callbacks.
- [ ] 5.5 For agents with `testable_mechanism = "deploy_webhook"`, the runner MUST register the merged-PR `job_id` so the deploy-complete webhook (section 7.5) can find it.
- [ ] 5.6 Implement a wall-clock timeout watchdog; on timeout, emit a synthetic `failed` callback whose reason names the timeout.
- [ ] 5.7 Unit tests: every terminal state emits exactly one callback; out-of-path modifications are rejected before commit; unknown `agent_name` emits `failed`.

## 6. Dispatch Route

- [ ] 6.1 Add `src/routes/builder-dispatch.ts` registering `POST /webhooks/system/builder` with the internal-bearer strategy.
- [ ] 6.2 Add `src/controllers/builder-dispatch.controller.ts` performing: bearer validation → payload Zod validation → resolve dispatching agent from `AGENTS_CONFIG` (404 if unknown) → re-verify `sender_identity` against the dispatching agent's allowlist (403 if not allowed) → enqueue Builder job → return 202.
- [ ] 6.3 Integration tests: missing bearer (401), invalid bearer (401), invalid payload (400), unknown `agent_name` (404), sender not on agent's allowlist (403), valid dispatch (202 + job enqueued), valid resume dispatch (202 + job enqueued with resume payload).
- [ ] 6.4 Confirm response time meets "respond 202 within 1 second under nominal load" (test asserts P95 under fake load).

## 7. Callback Routes and Idempotency

- [ ] 7.1 Add `src/routes/builder-callback.ts` registering `POST /webhooks/builder-callback` with the internal-bearer strategy.
- [ ] 7.2 Add `src/services/callback-dedupe.ts` backed by Redis `SETEX` with a 24-hour default TTL; key is `callback:event:<event_id>`.
- [ ] 7.3 Add `src/controllers/builder-callback.controller.ts` performing: bearer validation → payload Zod validation → dedupe check (return 202 on duplicate without side effects) → invoke operator-reply handler → return 202.
- [ ] 7.4 Implement the operator-reply handler that uses the echoed `reply_context` to dispatch back to the originating dispatching agent for outbound delivery; the handler MUST NOT block on Slack/Gmail API calls (fire-and-log).
- [ ] 7.5 Add `src/routes/builder-deploy-complete.ts` registering `POST /webhooks/builder-deploy-complete` with the internal-bearer strategy; handler looks up the job by `job_id`, emits `testable` on `status: "ok"` or `failed` on `status: "failed"`, returns 202.
- [ ] 7.6 Integration tests: duplicate `event_id` (single reply), unknown `event_id` (202 + warning log), each state's reply path, deploy-complete with `status: "ok"` triggers `testable`, deploy-complete with `status: "failed"` triggers `failed`.

## 8. Reply-Context Persistence (Dispatching-Agent-Side)

- [ ] 8.1 Define the contract for the dispatching agent to persist `{job_id → reply_context + {branch?, plan_path?, question_id?}}` in Redis with a 24-hour TTL, stored on dispatch, read on every callback, cleared on terminal state (`testable` or `failed`). Implementation lives in the dispatching agent's runtime (not in clawndom); clawndom only routes callbacks.
- [ ] 8.2 For `question_pending`, the dispatching agent's resume mapping additionally indexes by the channel-natural reply locator (Slack `thread_ts`, email `Message-ID`) so the operator's reply can find the right `job_id`.
- [ ] 8.3 Tests covering: persistence survives between original dispatch and `testable` callback; persistence is cleared after terminal callback; resume mapping resolves correctly from a quoted-reply.

## 9. Filesystem Boundary for Non-Builder Agents

- [ ] 9.1 Audit current tool grants for every ordinary agent in every opted-in agent-repo; inventory any filesystem-write tools.
- [ ] 9.2 Remove filesystem-write tools from ordinary-agent tool grants where they are not deliberately needed for the agent's role.
- [ ] 9.3 Configure agent invocation environments to mount source read-only at the OS level (container readonly rootfs or readonly bind mount on source paths).
- [ ] 9.4 Confirm each invocation starts from a fresh checkout — fail closed if a checkout appears to carry pre-existing modifications.
- [ ] 9.5 Integration test: a write to a source path from inside an ordinary agent's environment fails with EROFS / equivalent.

## 10. Per-Agent-Repo Onboarding Recipe

This section documents the per-agent-repo provisioning checklist. **The recipe is run by the operator (you), optionally automated by an outside agent like Patch — never by Builder herself.**

- [ ] 10.1 Document the checklist in `docs/builder-onboarding.md`:
  1. Create a dedicated GitHub App for Builder against the agent-repo (e.g., `<repo>-builder`).
  2. Install the App on the agent-repo only.
  3. Store credentials in 1Password under `Engineering` as item `GitHub App: <repo>-builder`.
  4. Add the new Builder bot to the agent-repo's branch-protection approved-bot allowlist (alongside any existing legitimate bots like Patch and Scarlett). DO NOT remove other allowed bots — branch protection is an allowlist, not an exclusion rule.
  5. For each ordinary agent in the agent-repo that should be able to dispatch to Builder, declare the per-agent fields in `AGENTS_CONFIG`: `builder_bot_ref`, optional `branch_naming_pattern`, `operator_allowlist` (start empty), `testable_mechanism` (default `deploy_webhook` for clawndom-resident agents), and the supervisor's deploy-webhook URL.
  6. For each operator-facing dispatching agent, add the `dispatch_to_builder` tool definition to that agent's tool registry, add the privileged-route template variant containing the allowlist rule and tool-usage guidance, and update tool-grant config so the tool is loaded only on the privileged route.
  7. Configure the supervisor (PM2 / systemd / k8s) to POST to `POST /webhooks/builder-deploy-complete` after each successful clawndom restart, supplying the `job_id` from the most-recently merged Builder PR.
- [ ] 10.2 Provide a `BuilderWorkspaceConfig` example for each `testable_mechanism` variant in `docs/builder-onboarding.md`.
- [ ] 10.3 (Optional) Author a Patch-runnable script that performs steps 1-4 (GitHub App provisioning, 1Password storage, branch-protection allowlist update) automatically given a repo URL and an existing-bots list.

## 11. Dispatching-Agent Callback Handling

The dispatching agent's runtime (not clawndom) is responsible for translating Builder callbacks into operator-visible replies.

- [ ] 11.1 Define the contract for the dispatching agent's callback receiver: interpret each Builder callback state and produce the appropriate operator-facing reply in the original channel using `reply_context`.
- [ ] 11.2 For `question_pending`: the dispatching agent stores `{question_id → {agent_name, branch, plan_path, reply_context}}` and, when the operator answers, fires a resume dispatch carrying `{agent_name, request: <answer>, reply_context, sender_identity, resume: {branch, answer}}`.
- [ ] 11.3 For `testable`: the dispatching agent's reply includes the `test_url` (if present) and the `pr_url`.
- [ ] 11.4 For `failed`: the dispatching agent's reply includes the `reason` framed for the operator.
- [ ] 11.5 Integration tests covering the full conversational round-trip including resume.

## 12. First Opt-In Agent: Smoke Test and Rollout

- [ ] 12.1 Run `make check-all` in clawndom; resolve any linter, type, or coverage gate failures (project floor: 87% lines/statements, 88% branches, 93% functions).
- [ ] 12.2 Choose the first opt-in agent and its repo; execute the section 10 checklist. Verify the new Builder bot credentials and the bearer fetch from 1Password before any code that references them lands.
- [ ] 12.3 With the agent's operator allowlist empty, dispatch a test request and confirm it is refused at every layer (agent's template refuses + clawndom 403 on re-verify).
- [ ] 12.4 Add a single test operator to the agent's allowlist; dispatch a trivial improvement scoped to the agent's `path` (e.g., "add a comment to the agent's README"); confirm Builder produces a PR authored by the new Builder bot, the branch name follows the configured convention, and `make check-all` (or equivalent) passes.
- [ ] 12.5 Confirm the supervisor restarts clawndom after the PR merges and then POSTs to the deploy-complete webhook; confirm `testable` reaches the dispatching agent and produces an operator-visible reply in the configured channel.
- [ ] 12.6 Test `question_pending` and resume end-to-end by configuring Builder to deliberately ask a question on a test request; confirm the answer reaches her via resume dispatch and she continues from the committed plan.
- [ ] 12.7 Test `failed` for each scope-violation reason: out-of-path modification, sibling-agent modification, `sharedTools` modification, clawndom modification.
- [ ] 12.8 Verify cleanup: after a `failed` callback, the working branch is deleted from the remote.
- [ ] 12.9 Enable for the agent's full operator set; document the per-agent rollback (empty the allowlist).

## 13. Follow-On (Out of Scope for This Change)

- [ ] 13.1 File a separate openspec change for **hot-reload in clawndom** (option 3): a file-watcher or polling mechanism that re-runs `loadAgents` (or a smaller refresh) without a process restart. Once shipped, opted-in agents can switch from `testable_mechanism = "deploy_webhook"` to `"cache_refresh"` to eliminate per-dispatch restarts.
