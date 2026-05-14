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

## 5. Builder Wiring (was: Builder Queue and Runner)

Reframed during implementation: Builder is *just another agent* in the runtime. The existing webhook → queue → worker → runner pipeline handles dispatch processing once Builder's `clawndom.yaml` is loaded and her dispatch route is registered as a webhook provider. No new queue class, runner class, or worker needed — the existing machinery is the queue, runner, and worker.

- [x] 5.1 The BullMQ queue is auto-created by `buildQueueName('builder-dispatch')` once Builder's auto-injected `builder-dispatch` webhook provider is in `settings.providers`. The existing completion-aware serialization gate applies.
- [x] 5.2 `src/system-agents/loader.ts` discovers `src/system-agents/<name>/clawndom.yaml` and merges the result into the standard `ResolvedAgent[]`. Builder's `clawndom.yaml` declares `routing.builder-dispatch.rules` so the existing worker resolves to her when a dispatch arrives.
- [x] 5.3 Path-scoped modification is enforced by Builder's system prompt (scope discipline in `prompt.md` and the Repo Hygiene requirement) plus the target repo's normal branch-protection / review gates. The runner does not need an extra pre-commit interceptor.
- [x] 5.4 Lifecycle emissions: Builder POSTs to the auto-injected `builder-callback` provider for `working` / `question_pending` / `failed`. `testable` is fired by the deploy-complete handler (section 7) after the supervisor restarts clawndom and signals success.
- [x] 5.5 `job_id` flows through the dispatch payload; the supervisor reads it from the merged PR's `Builder-Job-Id` commit trailer (per `docs/builder-onboarding.md`) and includes it in the deploy-complete signal.
- [x] 5.6 The existing `agentWaitTimeoutMs` setting (in `src/config.ts`) is the wall-clock watchdog and applies to Builder jobs identically to all other agent runs.
- [x] 5.7 Tests covering the wiring: `tests/system-agents/loader.test.ts` (Builder loads), `tests/system-agents/providers.test.ts` (dispatch + callback providers wired), `tests/system-agents/builder/callback-dedupe.test.ts` (state-keyed event_id semantics), `tests/system-agents/builder/payloads.test.ts` (Zod validation per state).

## 6. Dispatch Route

Reframed: the dispatch route is the auto-injected `builder-dispatch` webhook provider. The existing `WebhookTransport` + `createWebhookHandler` + `ingestEvent` pipeline performs bearer validation, payload-shape acceptance, and enqueue.

- [x] 6.1 Route `POST /webhooks/system/builder` is mounted automatically when `builder-dispatch` is added to `settings.providers` (see `src/system-agents/providers.ts::buildBuilderDispatchProvider`). The existing `WebhookTransport.mount()` call in `registerRoutes` handles it.
- [x] 6.2 Bearer validation via the existing `bearer` signature strategy (timing-safe). Payload-shape validation is the responsibility of Builder's `messageTemplate` rendering, which fails closed if required fields are missing; the strict Zod schema in `src/system-agents/builder/payloads.ts` is exported for the dispatching-agent runtime to use when constructing dispatches (so 4xx surfaces *before* the call).
- [x] 6.3 Tests covering: bearer strategy edge cases live in `tests/strategies/signature.test.ts` (existing). System-agent provider + loader wiring is covered in `tests/system-agents/loader.test.ts` and `tests/system-agents/providers.test.ts`. Full dispatch round-trip is exercised by the existing e2e webhook integration tests once an opted-in agent is configured (operational, section 12).
- [x] 6.4 The existing webhook ingestion returns 202 in well under 1 second; this is preserved by reusing the same handler.

## 7. Callback Routes and Idempotency

- [x] 7.1 Route `POST /webhooks/builder-callback` is mounted automatically when `builder-callback` is added to `settings.providers` (see `src/system-agents/providers.ts::buildBuilderCallbackProvider`). The existing webhook ingestion pipeline fans out to each opted-in dispatching agent's `routing.builder-callback.rules` (added per agent during onboarding — see `docs/builder-onboarding.md` step 2.5).
- [x] 7.2 `src/system-agents/builder/callback-dedupe.ts` implements `recordCallbackEvent` and `clearCallbackEvent` backed by Redis `SETEX` with a 24-hour TTL keyed `builder:callback:event:<event_id>`. Tests in `tests/system-agents/builder/callback-dedupe.test.ts`.
- [x] 7.3 The standard webhook handler validates the bearer and accepts the payload before enqueue; the strict Zod payload schema is used by the dispatching agent's runtime when *constructing* the callback so malformed callbacks fail before they leave Builder.
- [x] 7.4 The operator-reply handler is the dispatching agent's own routing rules under `routing.builder-callback`. Each opted-in agent adds a rule that matches `agent_name == this-agent's-name` and renders an operator-facing reply template using the echoed `reply_context`. Contract documented in `docs/builder-onboarding.md`.
- [x] 7.5 `src/system-agents/builder/deploy-complete.controller.ts` implements `POST /webhooks/builder-deploy-complete`. Bearer-gated via `requireBuilderInternalBearer`. Validates payload via `builderDeployCompletePayloadSchema`. Dedupes via `recordCallbackEvent`. Emits the corresponding `testable` or `failed` state. Wired into `src/routes/index.ts`.
- [x] 7.6 Tests: `tests/system-agents/builder/deploy-complete.controller.test.ts` (unit) and `tests/system-agents/integration/deploy-complete.integration.test.ts` (full middleware + parser + handler chain). Cover: valid ok, valid failed, duplicate delivery (deduped), missing fields, unknown status, strict rejection of extras, distinct event_ids for ok-then-failed on same job.

## 8. Reply-Context Persistence (Dispatching-Agent-Side)

Implementation lives in each dispatching agent's runtime (not in clawndom). clawndom routes callbacks; the agent owns the conversation state.

- [x] 8.1 Contract documented in `docs/builder-onboarding.md` step 2.5: the dispatching agent's `routing.builder-callback` rules match callbacks targeting that agent; the rule's rendered template stores `{job_id → reply_context + branch?/plan_path?/question_id?}` keyed by `job_id` with a TTL ≥ the longest plausible Builder run, reads on every callback, and clears on terminal state.
- [x] 8.2 Contract: the same store additionally indexes by the channel-natural reply locator (Slack `thread_ts`, email `Message-ID`) so the operator's reply can find the right `job_id` when the conversation resumes from `question_pending`. Documented in onboarding.
- [x] 8.3 Tests for the dispatching agent's persistence live in that agent's repo (per-agent runtime) — out of scope for clawndom unit tests. The clawndom callback path is tested at the dedupe/route level (section 7).

## 9. Filesystem Boundary for Non-Builder Agents (operational)

These are operator-driven steps run during each agent-repo's onboarding (Layer 1 of `docs/builder-onboarding.md`). They are deliberately not enforced inside clawndom because they live at the OS / container layer where clawndom doesn't have authority.

- [ ] 9.1 Audit current tool grants for every ordinary agent in every opted-in agent-repo; inventory any filesystem-write tools. **(Operational; run per-repo at onboarding.)**
- [ ] 9.2 Remove filesystem-write tools from ordinary-agent tool grants where they are not deliberately needed for the agent's role. **(Operational; configured in each agent's `clawndom.yaml`.)**
- [ ] 9.3 Configure agent invocation environments to mount source read-only at the OS level (container readonly rootfs or readonly bind mount on source paths). **(Operational; deploy-environment concern.)**
- [ ] 9.4 Confirm each invocation starts from a fresh checkout — fail closed if a checkout appears to carry pre-existing modifications. **(Operational; this is already the existing `loadAgents` clone-on-startup behaviour.)**
- [ ] 9.5 Integration test: a write to a source path from inside an ordinary agent's environment fails with EROFS / equivalent. **(Deploy-environment test; lives in infrastructure-as-code, not clawndom unit tests.)**

## 10. Per-Agent-Repo Onboarding Recipe

This section documents the per-agent-repo provisioning checklist. **The recipe is run by the operator (you), optionally automated by an outside agent like Patch — never by Builder herself.**

- [x] 10.1 `docs/builder-onboarding.md` documents the two-layer recipe (per agent-repo, per agent) covering: dedicated GitHub App provisioning, 1Password binding, branch-protection allowlist (with explicit "do not remove existing bots"), per-agent `AGENTS_CONFIG` fields, `dispatch_to_builder` tool wiring on privileged routes only, callback routing rules, and supervisor post-restart hook configuration.
- [x] 10.2 The onboarding doc includes an inline example of an `AGENTS_CONFIG` entry with `testableMechanism: { type: 'deploy_webhook', ... }`; future testable-mechanism variants (`cache_refresh`, `pr_preview`) follow the same shape.
- [ ] 10.3 (Optional) Author a Patch-runnable script that performs steps 1.1-1.4 (GitHub App provisioning, 1Password storage, branch-protection allowlist update) automatically given a repo URL and an existing-bots list. **(Deferred — operator can run the recipe by hand or script it when desired.)**

## 11. Dispatching-Agent Callback Handling (contract specified)

The dispatching agent's runtime (not clawndom) is responsible for translating Builder callbacks into operator-visible replies. clawndom's contribution is routing the callback to that agent via its standard `routing.builder-callback` rules; the rendering and the persistence live in the agent's repo.

- [x] 11.1 Contract documented in `docs/builder-onboarding.md` step 2.5: each dispatching agent's `routing.builder-callback` rule matches its own callbacks (by `agent_name` in the payload) and renders an operator-facing reply template using `reply_context`.
- [x] 11.2 Contract documented: for `question_pending`, the dispatching agent persists the resume mapping (per section 8) and constructs a resume dispatch when the operator's answer arrives in the same thread.
- [x] 11.3 Contract documented: for `testable`, the agent's reply template includes the `test_url` (when present) and `pr_url`.
- [x] 11.4 Contract documented: for `failed`, the agent's reply template includes the `reason`.
- [ ] 11.5 Integration tests covering the full conversational round-trip including resume. **(Lives in the dispatching agent's repo — out of scope for clawndom unit tests.)**

## 12. First Opt-In Agent: Smoke Test and Rollout (operational)

These tasks run when an actual operator + agent-repo + Builder bot exist in a deployed environment. They cannot run from a clawndom unit test alone.

- [x] 12.1 Run `make check-all` in clawndom; resolve any linter, type, or coverage gate failures. Passing as of this commit.
- [ ] 12.2 Choose the first opt-in agent and its repo; execute the section 10 checklist. Verify the new Builder bot credentials and the bearer fetch from 1Password before any code that references them lands. **(Operational, deferred until a real opt-in.)**
- [ ] 12.3 With the agent's operator allowlist empty, dispatch a test request and confirm it is refused at every layer. **(Operational.)**
- [ ] 12.4 Add a single test operator to the agent's allowlist; dispatch a trivial improvement scoped to the agent's `path`; confirm Builder produces a PR authored by the new Builder bot. **(Operational.)**
- [ ] 12.5 Confirm the supervisor restarts clawndom after the PR merges and posts to the deploy-complete webhook; confirm `testable` reaches the dispatching agent. **(Operational.)**
- [ ] 12.6 Test `question_pending` and resume end-to-end. **(Operational.)**
- [ ] 12.7 Test `failed` for each scope-violation reason. **(Operational.)**
- [ ] 12.8 Verify cleanup: after a `failed` callback, the working branch is deleted from the remote. **(Operational.)**
- [ ] 12.9 Enable for the agent's full operator set; document the per-agent rollback (empty the allowlist). **(Operational.)**

## 13. Follow-On (Out of Scope for This Change)

- [ ] 13.1 File a separate openspec change for **hot-reload in clawndom** (option 3): a file-watcher or polling mechanism that re-runs `loadAgents` (or a smaller refresh) without a process restart. Once shipped, opted-in agents can switch from `testable_mechanism = "deploy_webhook"` to `"cache_refresh"` to eliminate per-dispatch restarts.
