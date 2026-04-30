## Context

Today Clawndom has two ways for work to enter the system: HTTP webhooks (with HMAC + routing) and `routing.schedule` cron rules (statically defined in `clawndom.yaml`, dispatched by Clawndom's BullMQ-backed scheduler). Both terminate in the same per-provider queue and the same worker → runner pipeline.

Two friction points pushed this proposal:

1. **Maintenance gap.** Some periodic work isn't an agent prompt — it's a token refresh, a TLS renewal, a log rotation. Today operators put these in systemd timers on each agent's host. We just experienced the cost in winston-agency: the Gmail watch refresh systemd unit references a script path that the agent repo has now moved, and there is no automated way to keep the unit and the repo aligned.
2. **Agent self-scheduling gap.** Agents have no way to set themselves a reminder. "If Heather hasn't replied to this thread by Tuesday at 9, ping her." Today this requires either a separate human-driven cron rule per case or simply not being supported. The first beneficiary is Winston (follow-up reminders for inbox triage), but the same pattern would help Patch ("revisit this PR in 24h if no review") and Scarlett.

Both reduce to "schedule a runner invocation, optionally with payload, optionally recurring." The current static `routing.schedule` is the most-restricted special case of that primitive (config-only, no payload, runner=`claude-cli`). Generalizing the primitive lets both new use cases drop in.

## Goals / Non-Goals

**Goals:**
- One `ScheduledTask` model that subsumes static `routing.schedule` rules, runtime-created shell maintenance tasks, and runtime-created agent reminders.
- A `shell` runner type so command-style maintenance can live in the same Clawndom config as everything else, instead of in host systemd.
- An agent-callable tool (`clawndom.scheduleTask`) for self-scheduling, gated by per-agent caps to prevent runaway loops.
- Backwards-compatible: existing `routing.schedule` rules in `clawndom.yaml` keep working with no changes; the `runner` field on a rule defaults to `claude-cli`.
- Operationally observable: every lifecycle transition fires a typed event on the existing `EventBus`, surfacing in the dashboard.

**Non-Goals:**
- Payload templating (Nunjucks substitution into `runnerConfig` from `payload`) — keep `payload` as opaque JSON forwarded to the runner; render-time substitution is a follow-up if it's actually needed.
- Cross-agent scheduling (Winston creating a task for Patch). Single-agent scope.
- A full UI for managing scheduled tasks beyond the existing dashboard QUEUED section.
- Conditional firing ("only fire if X is true at fire time"). The current schedule predicate is wall-clock only; richer predicates can be added later if a use case arrives.
- Replacing webhook-driven work. This change introduces a complementary trigger path; webhooks stay as they are.

## Decisions

### Decision 1: One unified model, not two

Considered: separate "shell maintenance" and "agent reminder" mechanisms — each with its own model, store, and CRUD path. Rejected because the firing-side machinery (Redis-backed registry, BullMQ delayed/repeatable jobs, runner dispatch, event lifecycle) is identical in both cases. Two parallel systems would mean two sets of bugs and two sets of caps — and would still need a unification later when the third use case arrived. The runner-strategy abstraction already gives us the right seam: vary the runner, keep the trigger machinery shared.

### Decision 2: BullMQ as the firing engine

Considered: a custom node-cron + setTimeout scheduler. Rejected because we already use BullMQ for queues, BullMQ has first-class delayed jobs and repeatable jobs, and using a separate scheduler creates a second source of "what fires when" state across restarts. The scheduled-tasks registry becomes a thin metadata layer on top of BullMQ's repeatable-job and delayed-job APIs. Redis is the durable store; BullMQ owns the timing.

### Decision 3: Config-only `shell` runner from agents

The shell runner runs arbitrary commands. Letting agents create shell-runner tasks would let any agent prompt-injection escalate to host command execution, which is unacceptable for HIPAA-adjacent agents like Winston. Restricting agent-creatable runners to the LLM-mediated set (`claude-cli`, `openai`, `bedrock`, `null`) keeps the privilege boundary at the config layer where humans review changes.

Considered: per-agent allowlists of shell commands. Rejected for v1 — adds complexity without a known use case. Easy to add later if a real "agent maintenance" pattern emerges.

### Decision 4: Stable IDs for config-loaded tasks via content hash

Considered: assigning random UUIDs to config-loaded tasks on each load. Rejected because that would create a duplicate task on every restart (the previous one is orphaned in BullMQ until it fires) and force operators to manually reconcile. Hashing `(name, when, runner, runnerConfig)` produces a stable id — re-loading the same config is a no-op, changing any field reissues the task. For agent-created tasks, a UUID is fine because they're addressed by ownership not content.

### Decision 5: Caps enforced at the API, not in the tool wrapper

The agent-callable tool is a typed wrapper around the CRUD API. The trust boundary is the API, not the wrapper — an agent could in principle compose its own HTTP request to bypass the typed wrapper. So `maxPerTrace`, `maxFutureWindow`, and `maxRuns` are enforced server-side at the controller, with the wrapper just translating the 429 into a typed agent-side error. Defense in depth: the agent's tool surface is restrictive, but the API is the actual gate.

### Decision 6: Lifecycle events, not just create/fire

The dashboard should be able to render scheduled tasks faithfully — both upcoming (QUEUED) and historical (RECENT). Emitting `created`, `fired`, `cancelled`, `expired` covers every transition, so the dashboard's state machine is fully driven by events without polling Redis. This is identical to how `webhook.accepted` / `job.queued` / `runner.complete` already shape the dashboard for webhook-driven work.

### Decision 7: Memory injection passes through unchanged

`memory.retrieve` injection lives at the worker layer (`wrapWithMemoryFragments` in `worker.service.ts`), not at any trigger boundary. Scheduled task firings flow through the same worker pipeline as webhook events, so memory wrapping just works — provided the firing carries a `memory.retrieve` config. Concretely:

- **Static `routing.schedule` rules.** A rule with `memory.retrieve` already gets memory wrapping today; this change preserves that.
- **Agent-created scheduled tasks.** The firing reuses the parent agent's runner config wholesale, including any `memory.retrieve` block. So when Winston schedules a Tuesday-9am follow-up, the Tuesday firing pulls Winston's namespace memory the same way an inbound Slack ping would. Agents may override the inherited config by setting an explicit `memory` field in `runnerConfig` at schedule time, but the default is inheritance — agents shouldn't have to think about memory just because they're scheduling.
- **Shell runner.** No memory. There's no prompt to inject into; the field is silently ignored if set on a `shell` task. Worth a startup-time warning if config carries it (likely a typo).

The non-obvious part is the query source. `memory.retrieve.queryField` points at a path in the event payload — for webhooks, that's typically `event.text` or similar. For scheduled task firings, the natural source is the task's `payload`. So a follow-up reminder might use `queryField: 'payload.threadSubject'`. The agent (or config author) is responsible for putting a queryable string in `payload` at schedule time; if `queryField` resolves to nothing, memory recall returns the empty-marker block (already the existing behavior for webhooks with empty queries).

Considered: a parallel "scheduled-memory" config that decouples scheduled-task memory from webhook memory. Rejected — memory is a property of the agent's identity, not the trigger. Splitting them would let an agent's understanding of itself drift between contexts, which is exactly the problem durable memory solves.

## Risks / Trade-offs

- **[Risk] Runaway scheduling loops.** Agent A creates a task that fires in 1 second; the firing creates another that fires in 1 second; ad infinitum. → **Mitigation:** `maxPerTrace` (default 5) caps cumulative creates per single run, `maxFutureWindow` (default 365d) prevents "fire 1ms from now" spam, `maxRuns` caps total firings on recurring tasks. Caps are server-enforced and configurable per agent.
- **[Risk] Static-rule duplication on config changes.** A typo in a rule name produces a "new" rule on next load, leaving the old one as a phantom. → **Mitigation:** stable id derived from `(name, when, runner, runnerConfig)` hash means renaming creates a new task, but at least the old one's id is reproducible — a config-reconcile pass on startup deletes any `createdBy=config` task whose id is no longer present in the loaded rules.
- **[Risk] Shell runner is privileged.** Agent prompt-injection that creates a shell task = host command execution. → **Mitigation:** config-only restriction (Decision 3). Shell runner is unreachable from any agent-callable surface.
- **[Risk] BullMQ at-least-once delivery.** A scheduled task could fire twice if the worker dies between job pickup and ack. → **Mitigation:** worker-side dedup keyed on the BullMQ job id (existing pattern) absorbs the duplicate at the runner. For maintenance commands that are not idempotent, operators should make them idempotent (the Gmail watch refresh already is — calling watch() twice in a row is fine).
- **[Trade-off] No cross-runner type guarantees.** A `shell` runner emits `runner.tool_call`/`runner.complete` events that look syntactically like a one-step tool call, even though semantically it's a process spawn. The dashboard renders these uniformly. Slight conceptual stretch but keeps the event schema simple — preferable to introducing a parallel `process.*` event family.
- **[Trade-off] Tool surface lives outside the runner abstraction.** The `clawndom.scheduleTask` tool is a Clawndom-specific tool surfaced into runners that opt in (the same way the memory-recall tool is). It's not part of the runner-strategy abstraction itself; runners just expose Clawndom-defined tools when their config asks. Slight coupling, but the alternative (a runner-strategy-level "tools" abstraction) is heavier than the use case warrants.

## Migration Plan

1. **Phase 1 (shell runner only).** Implement `shell.runner.ts` and the runner-config schema change. Existing `routing.schedule` rules can adopt `runner: shell` immediately. Winston's gmail-watch-refresh moves from EC2 systemd to a `routing.schedule` rule in Winston's `clawndom.yaml`. Delete the systemd unit + the `infra/ec2/systemd/` directory. No new endpoints, no new agent tools — purely additive.
2. **Phase 2 (registry + CRUD).** Add the Redis-backed scheduled-task registry. Refactor the existing scheduler to load `routing.schedule` rules into the registry on startup (with content-hash ids). Add `/api/scheduled-tasks` endpoints. Existing behavior is unchanged externally; the registry is just an internal layer of indirection.
3. **Phase 3 (agent tool).** Add the `clawndom.scheduleTask` tool wiring + `scheduled_tasks` runner-config block. Agents that opt in get the tool; agents that don't are unaffected.

Each phase is independently shippable and provides standalone value. Phase 1 is the smallest and most urgent (it unblocks the winston-agency systemd cleanup); phase 2 prepares the foundation; phase 3 is the agent-facing capability.

**Rollback strategy:** Each phase is purely additive. If phase 3's tool surface causes problems, revoke `scheduled_tasks.enabled` per-agent and the tool disappears. If phase 2's registry has bugs, the static config-load path can fall back to the existing scheduler implementation behind a feature flag during the migration window. Phase 1's shell runner has no preexisting state to roll back from.

## Open Questions

- **Should `payload` be JSON-serializable only, or accept binary blobs?** Initial scope: JSON only. Binary payloads (e.g., Slack file uploads to defer) feel like a future need with an obvious workaround (URL pointer in JSON).
- **Should agent-created tasks be visible across agents?** Per the non-goal, no — single-agent scope. But the `/api/scheduled-tasks` API authenticated with Bearer is currently global. Open question whether the API should filter by agent automatically based on the calling traceId. For v1: API is global (operator tool), agent-callable tool filters to the calling agent.
- **What happens to a runtime-created task whose owning agent is removed from config?** The task continues to fire because it's keyed on a runner type, not on the agent. Probably fine — the runner still resolves and works. Worth a follow-up if we observe orphaned tasks in practice.
