## Why

Two unrelated-looking needs collapse into one missing primitive: agents need a way to schedule themselves for future work ("remind me Tuesday at 9am to follow up on this thread"), and operators need a way to schedule plain shell-style maintenance commands (Gmail watch refresh, certificate renewal, log rotation). Today the first is impossible — only static `routing.schedule` rules in `clawndom.yaml` exist, and they're config-time only. Today the second has to live outside Clawndom as systemd timers on each host, which creates a parallel source of truth that drifts the moment a script path changes (we just hit this with the winston-agency restructure: the Gmail watch refresh systemd unit on Winston's EC2 still references the pre-restructure script path while the script has moved). One unified scheduled-task primitive solves both.

## What Changes

- New `ScheduledTask` model: `(when, runner, runnerConfig, payload, createdBy, createdByTraceId, ttl, maxRuns, maxFutureWindow)`. Unifies "static cron rule" and "runtime-created reminder" into one record type.
- New `shell` runner type alongside `claude-cli`, `openai`, `bedrock`, `null`. Spawns a configured command (no template, no model invocation), captures stdout/stderr, emits the existing `runner.*` events, exit code drives `runner.complete` vs `runner.error`. **BREAKING for runner type union — existing code that exhaustively matches runner types must add the `shell` arm; existing config files unaffected (default still `claude-cli`).**
- Generalize `routing.schedule`: existing config rules continue to work unchanged, with an added optional `runner` field (defaults to `claude-cli`) so a config rule can be `runner: shell, command: "python3 ./tools/refresh_gmail_watch.py"`.
- Runtime CRUD over Redis-backed scheduled-task store: `GET/POST/DELETE /api/scheduled-tasks` (Bearer auth, like the memory endpoints). Uses BullMQ delayed/repeatable jobs internally; the registry just tracks ownership and metadata.
- Agent-callable tool surfaced when an agent's runner config opts in (`scheduled_tasks: { enabled: true, maxPerTrace: 5, maxFutureWindow: 365d }`). Typed wrapper around the CRUD endpoints. Caps prevent runaway scheduling loops. **Initial scope: agents can only create `claude-cli` scheduled tasks — `shell` runner is config-only for security.**
- Dashboard's QUEUED section gains scheduled tasks; new event types fire on scheduled-task create / fire / cancel / expire.

## Capabilities

### New Capabilities

- `scheduled-tasks`: The scheduled-task model, the runtime store and CRUD API, the firing engine that hands tasks to runners on schedule, agent-tool surface for self-scheduling, and the runaway-loop caps. Replaces what was previously implicit-only inside `webhook-proxy-domain` (scheduled cron transport).

### Modified Capabilities

- `agent-runner-strategy`: Adds the `shell` runner type to the strategy union with its own contract (no prompt, no template, command-driven, exit-code-mapped). Updates the Agent Runner Abstraction and Configuration Schema requirements.

(Note: `api-design` and `webhook-proxy-domain` are touched at the implementation level — new `/api/scheduled-tasks` endpoints, scheduled-task firings flow through existing per-provider queues and Transport Durability rules — but no spec-level requirement changes. Those capabilities are not modified.)

## Impact

- **Code**: New `src/runners/shell.runner.ts` (strategy implementation), new `src/services/scheduled-tasks.service.ts` (registry + firing engine), new `src/controllers/scheduled-tasks.controller.ts` (CRUD), new `src/routes/scheduled-tasks.routes.ts`. Modifications to `src/services/scheduler.service.ts` (or wherever `routing.schedule` is loaded today) to upsert into the registry on startup. Modifications to runner-config schemas to accept the new `runner` and `scheduled_tasks` fields.
- **APIs**: New `GET/POST/DELETE /api/scheduled-tasks` endpoints under existing Bearer-auth scheme. New deferred tool definition for `clawndom.scheduleTask` exposed to runners that opt in.
- **Dependencies**: No new external dependencies — Redis (already in use), BullMQ (already in use for queues; same library has delayed/repeatable jobs).
- **Configuration**: `clawndom.yaml` `routing.schedule.rules[].runner` is new and optional. Per-agent `runner.scheduled_tasks` block is new and optional. Both backwards-compatible.
- **Operational**: The first beneficiary is Winston — `gmail-watch-refresh` moves from EC2 systemd into Clawndom config, eliminating the systemd-vs-repo drift we just observed. `infra/ec2/systemd/` in winston-agency can then be deleted. Future agents can self-schedule reminders without any host-level coupling.
