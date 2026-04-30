## ADDED Requirements

### Requirement: Scheduled Task Model

The runtime SHALL maintain a `ScheduledTask` record type that uniformly represents both static config-defined schedules and runtime-created scheduled work. Every scheduled task MUST carry:

- `id` — stable string identifier. For `createdBy=config` tasks, derived from a hash of `(name, when, runner, runnerConfig)` so re-loading the same config does not duplicate.
- `when` — one of `{cron: <expr>, timezone: <tz>}` for recurring or `{fireAt: <unix-ms>}` for one-time.
- `runner` — a runner type string from the `agent-runner-strategy` registry.
- `runnerConfig` — the runner-specific config the registered runner expects when invoked.
- `payload` — optional opaque JSON object forwarded to the runner at fire time as the `payload` context variable.
- `createdBy` — `config` (loaded from `clawndom.yaml`) or `agent` (created at runtime by an agent-callable tool).
- `createdByTraceId` — for `createdBy=agent` only; the traceId of the run that created this task. Required for ownership tracking and runaway-loop caps.
- `ttl` — optional auto-expire (unix-ms or duration). Tasks past their TTL MUST NOT fire and SHOULD be evicted.
- `maxRuns` — optional cap on the total number of times this task fires; tasks past their `maxRuns` MUST NOT fire and SHOULD be evicted.

#### Scenario: Config-Defined Task Has Stable ID Across Restarts
- **WHEN** Clawndom restarts with an unchanged `clawndom.yaml`
- **THEN** Each `routing.schedule` rule MUST produce a `ScheduledTask` record with the same `id` as before the restart, so re-loading does not create a duplicate task

#### Scenario: Runtime-Created Task Carries Trace Provenance
- **WHEN** An agent calls the scheduled-task creation tool during a run with traceId `T123`
- **THEN** The resulting `ScheduledTask` record MUST have `createdBy='agent'` and `createdByTraceId='T123'`

#### Scenario: Task Past Max Runs Does Not Fire
- **GIVEN** A scheduled task with `maxRuns=3` that has already fired 3 times
- **WHEN** Its next scheduled time elapses
- **THEN** The runtime MUST NOT invoke the runner; the task SHOULD be removed from the registry

#### Scenario: Task Past TTL Does Not Fire
- **GIVEN** A scheduled task with `ttl` set to a past timestamp
- **WHEN** Its next scheduled time elapses
- **THEN** The runtime MUST NOT invoke the runner; the task SHOULD be removed from the registry

### Requirement: Persistent Registry Survives Restart

The scheduled-task registry MUST be backed by Redis (the same Redis instance Clawndom already uses for BullMQ queues and dedup). Records MUST survive process restart. The runtime SHALL NOT rely on in-memory state for which tasks exist or when they fire next; in-memory caches are read-through and rebuilt from Redis on startup.

#### Scenario: Agent-Created Task Survives Process Restart
- **GIVEN** An agent created a scheduled task to fire 24 hours in the future
- **WHEN** Clawndom restarts an hour after creation
- **THEN** The task MUST still exist in the registry and MUST fire at its originally scheduled time

#### Scenario: Removed Config Rule Is Cleaned On Restart
- **GIVEN** A `routing.schedule` rule named `morning-briefing` was previously loaded as a scheduled task
- **WHEN** That rule is removed from `clawndom.yaml` and Clawndom restarts
- **THEN** The corresponding `createdBy=config` task MUST be removed from the registry; agent-created tasks MUST be untouched

### Requirement: Firing Engine Routes To Runner Registry

When a scheduled task's fire time elapses, the firing engine MUST resolve the task's `runner` against the agent-runner-strategy registry and invoke that runner with the task's `runnerConfig` and `payload`. The firing engine MUST NOT be coupled to any specific runner implementation.

A scheduled-task firing MUST flow through the same per-provider BullMQ enqueue path as inbound webhooks, satisfying the existing Transport Durability requirement in `webhook-proxy-domain`.

#### Scenario: Firing With Claude-CLI Runner
- **GIVEN** A scheduled task with `runner='claude-cli'` and `runnerConfig.template='templates/morning-briefing.md'`
- **WHEN** The task's fire time elapses
- **THEN** The runtime MUST enqueue the firing to the BullMQ queue, the worker MUST render the template with the task's `payload` as context, and a `claude -p` subprocess MUST be invoked with the rendered prompt

#### Scenario: Firing With Shell Runner
- **GIVEN** A scheduled task with `runner='shell'` and `runnerConfig.command='python3 ./tools/refresh_gmail_watch.py'`
- **WHEN** The task's fire time elapses
- **THEN** The runtime MUST enqueue the firing to the BullMQ queue and the worker MUST invoke the shell runner with the configured command; no template rendering occurs

#### Scenario: Firing Survives Crash During Invocation
- **GIVEN** A scheduled task fires and is enqueued, then Clawndom crashes before the worker picks up the job
- **WHEN** Clawndom restarts
- **THEN** The enqueued firing MUST be picked up by the worker on the same per-provider queue (BullMQ at-least-once delivery)

### Requirement: CRUD API For Scheduled Tasks

Clawndom SHALL expose a REST CRUD API for scheduled tasks under `/api/scheduled-tasks`, authenticated with the same Bearer-token scheme used by the memory endpoints. Endpoints:

- `GET /api/scheduled-tasks` — list all tasks; supports `?createdBy=config|agent`, `?agentId=<id>`, `?createdByTraceId=<id>` query filters; supports cursor-based pagination per `api-design`.
- `POST /api/scheduled-tasks` — create a new task; body validated with Zod; rejects invalid `when` (must have either `cron` or `fireAt`), invalid `runner` (not in registry), and known cap violations (see "Runaway Loop Caps"). Returns the created task.
- `GET /api/scheduled-tasks/:id` — return one task or 404.
- `DELETE /api/scheduled-tasks/:id` — cancel/remove a task; returns 204. Removing a `createdBy=config` task is allowed but the task SHOULD be re-created on next config reload — operators are warned in the response body.

#### Scenario: Create One-Time Reminder
- **WHEN** A client `POST`s `{when: {fireAt: <future-ms>}, runner: 'claude-cli', runnerConfig: {template: 'templates/reminder.md'}, payload: {threadId: 'X'}}`
- **THEN** The endpoint MUST validate the body, persist the task, and return the task with its assigned `id`

#### Scenario: Reject Invalid Runner Type On Create
- **WHEN** A client `POST`s a task with `runner='unknown-runner'`
- **THEN** The endpoint MUST return 400 with a validation error naming the unknown runner type; the registry MUST NOT be modified

#### Scenario: Cancel Removes From Registry And BullMQ
- **GIVEN** A scheduled task exists with id `T999` and a delayed job in BullMQ
- **WHEN** A client `DELETE`s `/api/scheduled-tasks/T999`
- **THEN** The endpoint MUST remove the registry record AND remove the corresponding BullMQ delayed/repeatable job; the task MUST NOT fire after this point

### Requirement: Agent-Callable Tool Surface

Agents whose runner config opts in via `scheduled_tasks: { enabled: true, ... }` SHALL be exposed a deferred tool with the contract:

- `clawndom.scheduleTask({when, runner, runnerConfig, payload?})` — returns the created task's `id` and `nextFireAt`.
- `clawndom.listScheduledTasks(filter?)` — returns the calling agent's scheduled tasks (filtered to `createdByTraceId=current` by default; runner config MAY allow listing all tasks owned by the same agent).
- `clawndom.cancelScheduledTask(id)` — cancels a task the agent owns; rejects if the task is not owned by this agent's traces.

The tool MUST be implemented as a typed wrapper around the CRUD API, not as a separate code path. Agents MUST NOT be able to bypass the API's validation or caps via the tool.

#### Scenario: Agent Schedules Future Reminder
- **GIVEN** An agent runner configured with `scheduled_tasks.enabled=true`
- **WHEN** The agent calls `clawndom.scheduleTask({when: {fireAt: <next-tuesday-9am>}, runner: 'claude-cli', runnerConfig: {template: 'templates/follow-up.md'}, payload: {threadId: 'X'}})`
- **THEN** A new task MUST be created with `createdBy='agent'` and `createdByTraceId` set to the calling run's traceId; the tool MUST return the assigned id and nextFireAt

#### Scenario: Agent Without Opt-In Has No Tool
- **GIVEN** An agent runner config without a `scheduled_tasks` block (or with `enabled: false`)
- **WHEN** The agent attempts to call `clawndom.scheduleTask(...)`
- **THEN** The tool MUST NOT be registered for this run; the call MUST fail with `tool not available` at the runner layer

### Requirement: Runaway Loop Caps

To prevent agents from creating self-feeding scheduling loops, every agent runner that opts into `scheduled_tasks` MUST configure caps. The runtime MUST enforce these caps server-side (not client-side; the agent-callable tool's typed wrapper is not the trust boundary):

- `maxPerTrace` — the maximum number of `clawndom.scheduleTask` calls allowed within one run (default 5; configurable per agent). Counts cumulative calls across the run, not net surviving tasks.
- `maxFutureWindow` — the furthest in the future an agent-created task may be scheduled (default 365d; configurable per agent). `when.fireAt` or `when.cron`'s next-fire MUST fall within this window.
- `maxRuns` — for recurring agent-created tasks, the cap on total firings (default unlimited but configurable per agent; recommend 365 for daily-cron defaults so a typo doesn't run forever).

Cap violations MUST return 429 from the CRUD API and surface to the agent tool as a typed error (not a silent failure).

#### Scenario: Agent Exceeds Per-Trace Cap
- **GIVEN** `maxPerTrace=5` and the agent has already called `clawndom.scheduleTask` 5 times in the current run
- **WHEN** The agent calls `clawndom.scheduleTask` a 6th time
- **THEN** The runtime MUST reject the call with a typed `cap-exceeded` error naming `maxPerTrace`; no task is created

#### Scenario: Agent Schedules Past Future Window
- **GIVEN** `maxFutureWindow=365d`
- **WHEN** The agent attempts to schedule `{fireAt: <now+400d>}`
- **THEN** The runtime MUST reject the call with a typed `cap-exceeded` error naming `maxFutureWindow`; no task is created

### Requirement: Agent-Created Tasks Restricted To Safe Runners

Agents MUST only be able to create scheduled tasks targeting runners that do not allow arbitrary command execution. Specifically: the `shell` runner MUST be config-only (`createdBy='config'`). Attempts to create an agent-owned task with `runner='shell'` MUST be rejected.

The set of agent-creatable runners is `{claude-cli, openai, bedrock, null}`. The set of config-creatable runners is the full registry.

#### Scenario: Agent Cannot Schedule Shell Command
- **WHEN** An agent calls `clawndom.scheduleTask({runner: 'shell', runnerConfig: {command: '...'}, when: {...}})`
- **THEN** The runtime MUST reject with a typed `forbidden-runner` error; no task is created

#### Scenario: Config Can Schedule Shell Command
- **GIVEN** A `routing.schedule` rule in `clawndom.yaml` with `runner: shell, command: 'python3 ./tools/refresh_gmail_watch.py'`
- **WHEN** Clawndom loads the config on startup
- **THEN** A `ScheduledTask` record MUST be created with `runner='shell'`, `createdBy='config'`

### Requirement: Memory Configuration Inherits And Applies Per-Runner

`memory.retrieve` configuration MUST flow through scheduled task firings the same way it flows through webhook firings. Memory wrapping happens at the worker layer; the trigger (webhook, static cron rule, or agent-created scheduled task) is irrelevant to whether memory is applied.

- For `runner: 'claude-cli'` (and other prompt-rendering runners): if the firing carries a `memory.retrieve` config (either on the rule's `runnerConfig.memory` or inherited from the agent's runner config when an agent created the task), the worker MUST wrap the rendered prompt with memory recall and storage fragments before invoking the runner.
- For `runner: 'shell'`: memory configuration MUST be ignored. Shell runs have no prompt to wrap. If `memory` is present in a shell-runner task's `runnerConfig`, the runtime SHOULD log a warning at config validation time naming the offending task (likely a misconfiguration).
- Agent-created scheduled tasks MUST inherit the creating agent's full runner config (including any `memory.retrieve`) by default. Agents MAY override the memory block by passing an explicit `memory` field in the `runnerConfig` argument to `clawndom.scheduleTask`. The override applies to the firing only; it does not modify the agent's runtime config.

The query source for memory recall on a scheduled-task firing is the task's `payload`. The standard `memory.retrieve.queryField` path resolves against the firing's payload (e.g., `queryField: 'payload.threadSubject'`). If the queryField path resolves to an empty or missing value, memory recall returns the existing empty-marker block (no memory hits) — same behavior as a webhook firing with an empty query.

#### Scenario: Static Schedule Rule With Memory Wraps Prompt
- **GIVEN** A `routing.schedule` rule with `runner: { type: 'claude-cli', template: 'templates/morning-briefing.md', memory: { retrieve: { namespace: 'winston-personal', queryField: 'rule.name', topK: 5 } } }`
- **WHEN** The cron fires
- **THEN** The worker MUST inject memory recall and storage fragments into the rendered template before spawning `claude -p`, identical to how it would for a webhook firing on the same agent

#### Scenario: Agent-Created Reminder Inherits Memory From Runner Config
- **GIVEN** Winston's slack-winston runner config has `memory.retrieve` enabled with `namespace: 'winston-personal'`
- **WHEN** Winston calls `clawndom.scheduleTask({when: <future>, runner: 'claude-cli', runnerConfig: {template: 'templates/follow-up.md'}, payload: {threadSubject: '...'}})` (no explicit memory block)
- **THEN** The created scheduled task MUST inherit Winston's runner config including `memory.retrieve`, AND when it fires, the worker MUST inject memory fragments using `payload.threadSubject` as the query (per `queryField` resolution)

#### Scenario: Agent Override Of Memory Block On A Scheduled Task
- **GIVEN** An agent calls `clawndom.scheduleTask` with an explicit `runnerConfig.memory: { retrieve: { ...different config... } }`
- **WHEN** The task fires
- **THEN** The override MUST apply for that firing only; the agent's runtime config MUST NOT be mutated

#### Scenario: Shell Runner Ignores Memory Config
- **GIVEN** A static `routing.schedule` rule with `runner: 'shell'` and a `memory.retrieve` block (likely misconfiguration)
- **WHEN** Clawndom loads config at startup
- **THEN** The runtime SHOULD log a warning identifying the rule and the unused memory config; the rule MUST still load successfully and fire normally; memory MUST NOT be applied (shell runs have no prompt)

### Requirement: Observable Lifecycle Events

The runtime MUST emit typed `ClawndomEvent`s on the existing `EventBus` for the full scheduled-task lifecycle:

- `scheduled-task.created` — when a task is added to the registry (config-load, API POST, or agent tool)
- `scheduled-task.fired` — when a task fires and a worker job is enqueued; includes the task id and the resulting BullMQ jobId
- `scheduled-task.cancelled` — when a task is removed via `DELETE` or agent cancel
- `scheduled-task.expired` — when a task is removed because of `ttl` or `maxRuns`

Events MUST carry enough context for the dashboard to render scheduled tasks in its QUEUED section without additional API calls (task id, when-next, runner, createdBy, owner traceId where applicable).

#### Scenario: Created Event Fires On Startup Config Load
- **WHEN** Clawndom starts and loads N `routing.schedule` rules from config
- **THEN** Exactly N `scheduled-task.created` events MUST be published before any other startup signal indicates "ready"

#### Scenario: Fired Event Carries BullMQ Job Linkage
- **WHEN** A scheduled task fires and the runtime enqueues a worker job
- **THEN** The `scheduled-task.fired` event MUST include both the scheduled-task `id` and the resulting BullMQ `jobId`, so dashboard handlers can link the firing to the eventual `runner.complete`/`runner.error`
