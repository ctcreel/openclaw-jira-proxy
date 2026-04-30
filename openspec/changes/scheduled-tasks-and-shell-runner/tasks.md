## 1. Phase 1 — Shell Runner

- [ ] 1.1 Create `src/runners/shell.runner.ts` implementing the `AgentRunner` interface: spawn the configured command as a child process, capture stdout and stderr (bounded), enforce `timeoutMs` with SIGTERM-then-SIGKILL semantics, emit `runner.tool_call` on spawn and `runner.complete`/`runner.error` on exit
- [ ] 1.2 Register `shell` in the runner registry (`src/runners/index.ts`); ensure unknown-runner-type startup error message lists it
- [ ] 1.3 Extend the runner-config Zod discriminated union in `src/config.ts` with the `shell` variant: required `command: string`, optional `cwd: string`, optional `env: Record<string, string>`, optional `timeoutMs: number` (default 300000)
- [ ] 1.4 Allow per-rule `runner` override on `routing.schedule` rules in the agent config schema; rule-level runner takes precedence over agent-level runner
- [ ] 1.5 Unit tests for the shell runner: clean exit, non-zero exit, timeout, SIGTERM-during-grace, stdout/stderr capture, env merge, cwd resolution
- [ ] 1.6 Unit tests for the config schema: `runner: shell` accepted, missing `command` rejected, `timeoutMs` default applied
- [ ] 1.7 Integration test: a `routing.schedule` rule with `runner: shell` fires per cron and the shell runner's `runner.complete` event flows through the existing event pipeline
- [ ] 1.8 Update `make check-all` to pass with new code
- [ ] 1.9 Document the shell runner type in clawndom's `docs/runners.md` (or wherever runner types are listed)

## 2. Phase 1 — winston-agency migration

- [ ] 2.1 Add a `routing.schedule` rule to Winston's `clawndom.yaml` for `gmail-watch-refresh` with `runner: shell, command: "python3 ./tools/refresh_gmail_watch.py"`, weekly cron
- [ ] 2.2 After Clawndom phase 1 ships, remove `infra/ec2/systemd/gmail-watch-refresh.service` and `.timer` from winston-agency, plus the `infra/` directory if empty
- [ ] 2.3 On Winston's EC2: `systemctl disable --now gmail-watch-refresh.timer && systemctl daemon-reload` to remove the now-orphaned unit
- [ ] 2.4 Update winston-agency README to drop the `infra/ec2/systemd/` row from the layout table

## 3. Phase 2 — Scheduled Task Registry

- [ ] 3.1 Define `ScheduledTask` type in `src/types/scheduled-task.ts` with the fields specified in `specs/scheduled-tasks/spec.md` (`id`, `when`, `runner`, `runnerConfig`, `payload?`, `createdBy`, `createdByTraceId?`, `ttl?`, `maxRuns?`)
- [ ] 3.2 Implement content-hash id derivation for `createdBy=config` tasks: stable hash of `(name, when, runner, runnerConfig)` so re-loading the same config does not duplicate
- [ ] 3.3 Create `src/services/scheduled-tasks.service.ts`: Redis-backed persistence (hash + sorted set keyed by next-fire), CRUD operations, BullMQ delayed/repeatable-job adapter
- [ ] 3.4 Refactor the existing `routing.schedule` loader to upsert into `scheduled-tasks.service` on startup; add a config-reconcile pass that deletes `createdBy=config` records whose ids are no longer present in the loaded config
- [ ] 3.5 Wire `scheduled-task.created` / `.fired` / `.cancelled` / `.expired` lifecycle events on the existing `EventBus`
- [ ] 3.6 Unit tests for the registry service: create, get, list (including filters), delete, restart-survival semantics, content-hash id stability
- [ ] 3.7 Unit tests for the lifecycle event emissions: each transition fires exactly the expected events with the right payloads
- [ ] 3.8 Integration test for restart survival: create a delayed task, restart the test server, verify the task still fires at the original time

## 4. Phase 2 — CRUD API

- [ ] 4.1 Create `src/controllers/scheduled-tasks.controller.ts`: `GET /api/scheduled-tasks` (list with `?createdBy=`, `?agentId=`, `?createdByTraceId=` filters; cursor-based pagination per `api-design`), `POST /api/scheduled-tasks` (Zod-validated body), `GET /api/scheduled-tasks/:id`, `DELETE /api/scheduled-tasks/:id`
- [ ] 4.2 Create `src/routes/scheduled-tasks.routes.ts` mounting the controller with the same Bearer-token middleware used by the memory routes
- [ ] 4.3 Reject `POST` with `runner: shell` when the request is from an agent context; only allow `shell` for config-creation paths (initial guard for Decision 3 — actual runner whitelist happens in 5.2 once the agent-tool path exists)
- [ ] 4.4 Controller tests: every Zod-rejection path, list filters, pagination cursor round-trip, 404 on missing id, 204 on delete, 401 on missing/bad bearer

## 5. Phase 3 — Agent Tool

- [ ] 5.1 Add a `scheduled_tasks` block to the agent-runner config schema: `enabled: boolean (default false)`, `maxPerTrace: number (default 5)`, `maxFutureWindow: string-duration (default "365d")`, `maxRuns: number (default unlimited)`
- [ ] 5.2 Implement `clawndom.scheduleTask` / `listScheduledTasks` / `cancelScheduledTask` as a runtime tool surfaced when `scheduled_tasks.enabled=true`. Tool handlers translate to the CRUD API; per-trace counter lives in Redis keyed on `traceId`; cap-violation 429 from API surfaces as a typed `cap-exceeded` error to the runner
- [ ] 5.3 Server-side enforcement of the agent-creatable runners whitelist (`{claude-cli, openai, bedrock, null}`) — `shell` is rejected from the agent path with a typed `forbidden-runner` error
- [ ] 5.4 Agent-created tasks inherit the calling agent's runner config (including `memory.retrieve`) by default; `runnerConfig.memory` passed explicitly to `clawndom.scheduleTask` overrides the inherited value for that firing only and MUST NOT mutate the runtime config
- [ ] 5.5 Integration test: an agent runner configured with `scheduled_tasks.enabled=true` calls `clawndom.scheduleTask`; the task fires at the right time; payload reaches the next run
- [ ] 5.6 Cap tests: 6th `clawndom.scheduleTask` call in one run is rejected with `cap-exceeded(maxPerTrace)`; future-window violation rejected with `cap-exceeded(maxFutureWindow)`; agent attempt to create `shell` task rejected with `forbidden-runner`
- [ ] 5.7 Tool not registered when `scheduled_tasks.enabled=false`: agent attempts to call the tool fail at the runner layer with `tool not available`

## 5a. Phase 3 — Memory Passthrough

- [ ] 5a.1 Verify the worker's `wrapWithMemoryFragments` resolves `memory.retrieve.queryField` against the firing's `payload` for scheduled-task triggered jobs (same path resolution it uses against webhook event bodies); add a test that exercises a scheduled-task firing with `queryField: 'payload.threadSubject'` and confirms the embedded query matches the payload value
- [ ] 5a.2 Static `routing.schedule` rule with `memory.retrieve`: integration test that a daily-cron firing wraps the rendered prompt with memory recall + storage fragments before invoking claude-cli, end-to-end against a test memory namespace
- [ ] 5a.3 Agent-created task inherits memory: integration test that an agent with `memory.retrieve` enabled in its runner config calls `clawndom.scheduleTask` with no explicit memory block, and the resulting firing applies memory wrapping using the inherited config
- [ ] 5a.4 Agent-created task with explicit memory override: integration test that an agent passes `runnerConfig.memory: { retrieve: { namespace: 'other', topK: 1 } }` and the firing uses the override (not the inherited config); the agent's runtime config is unchanged after the call
- [ ] 5a.5 Shell runner with memory misconfiguration: unit test that a config with `runner: shell` AND `memory.retrieve` loads successfully but emits a startup-time warning identifying the rule; the rule still fires; memory is not applied to the shell run

## 6. Phase 3 — Dashboard Integration

- [ ] 6.1 Update `scripts/dashboard.py` to consume the new lifecycle events; render scheduled tasks in the QUEUED section with their next-fire time and runner type; render `scheduled-task.fired` linkage to the resulting BullMQ jobId so the firing connects visually to the eventual `runner.complete`
- [ ] 6.2 Coordinate with SPE-1976 (dashboard fidelity / replay buffer): scheduled-task lifecycle events MUST be in the events ring buffer, so dashboard restarts can rebuild the QUEUED state from snapshot + replay rather than only from new events

## 7. Documentation and Release

- [ ] 7.1 Update `openspec/specs/agent-runner-strategy/spec.md` and create `openspec/specs/scheduled-tasks/spec.md` from the change deltas (this is the archive step — `openspec archive` after the change is fully apply-complete)
- [ ] 7.2 Document `scheduled_tasks` agent-config block in agent-author README guidance
- [ ] 7.3 Document the `clawndom.scheduleTask` tool surface (parameters, errors, cap semantics) for agent-template authors
- [ ] 7.4 Document the shell runner's security boundary (config-only) in security-relevant docs
