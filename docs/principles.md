# Clawndom Principles

Cross-cutting principles that span multiple tickets. The Why behind constraints that would otherwise be re-debated each time a new feature lands.

If a proposed change conflicts with one of these, the change isn't necessarily wrong — but the conflict needs to be visible in the ticket and acknowledged in review, not glossed over.

---

## 1. Clawndom is the runtime, not the application.

Clawndom's job: receive events (HTTP webhooks, Slack Socket Mode, scheduled crons), validate signatures, route to the right agent rule, render templates, hand prompts to a runner, observe and log the result.

Clawndom's job is not: knowing the shape of a Gmail message, holding OAuth tokens for Google, formatting Jira issue links, talking to Xero, posting Slack messages with custom blocks, or any other domain integration.

**Implication 1**: Shared agent tooling — Gmail helpers, Slack reply helpers, calendar wrappers, etc. — lives in a separate `agency-tools` package, not in Clawndom. Each agent vendors a pinned version. Updating agency-tools doesn't ripple into Clawndom CI or deploys.

**Implication 2**: Provider transports (webhook, Slack Socket Mode) belong in Clawndom because they're orchestration. Domain payload knowledge (parsing a Slack message into intent, extracting a Jira issue key) sits at the edge — context strategies, condition AST, and template rendering — but doesn't cause Clawndom to import API SDKs for those services.

**Implication 3**: When a feature feels like it wants to grow into Clawndom's core, ask: "would this change require Clawndom to depend on a vendor SDK we don't already use?" If yes, push it into agency-tools or a per-agent helper.

---

## 2. Agents are configured, not coded into Clawndom.

Each agent is a git repo with its own `clawndom.yaml` (routing rules, schedules, model preferences) and templates. Clawndom clones agent repos at startup and reloads on `clawndom-sync-agents.timer` fires. Adding an agent does not require a Clawndom code change.

**Implication 1**: Agent-specific behavior (Patches handles GitHub PRs, Winston handles Heather's email, Scarlett posts handoffs) lives entirely in the agent's repo. Clawndom never knows what an agent does — only how to dispatch to it.

**Implication 2**: When tempted to add an agent-specific code path in Clawndom (a feature flag, a special case), the right answer is almost always to extend the routing or template config so the behavior expresses in agent config instead.

**Implication 3**: Routing rules use a generic condition AST (`equals`, `in`, `matches`, `exists`, `any_of`, `all_of`, `not`, `any_item`). New rule kinds get new AST primitives, not provider-specific routing code.

---

## 3. Every event survives a process restart.

Webhook acceptance writes to BullMQ before responding. Scheduled jobs are BullMQ repeatables, not in-memory cron. Internal task dispatches go through the same queue infrastructure. A Clawndom restart never drops in-flight work.

**Implication 1**: Anything that holds state across requests goes through Redis (BullMQ queues, dedup keys, repeatable schedulers). Process-local state is for hot paths only.

**Implication 2**: New transports (e.g., Slack Socket Mode) must enqueue to a queue before doing any agent work. Synchronous "receive event → run agent" inline paths violate this and create work loss on restart.

**Implication 3**: Queue names are stable across restarts. Naming conventions matter; see `docs/standards/NAMING_CONVENTIONS.md`.

---

## 4. Tests are the contract, not the inspection.

A new feature without unit tests is a feature without a contract — future changes can break it silently. Clawndom's `make check-all` is the gate, and it is non-negotiable.

**Implication 1**: New strategies (signature, context, transport) ship with unit tests covering the happy path, the auth-failure path, and at least one malformed-input path. Same for new services.

**Implication 2**: Behavior that depends on external services (Slack, Redis, the Anthropic API) is wrapped in adapters that can be faked in tests. No test should require real network.

**Implication 3**: When a bug is found in production, the fix lands with a test that would have caught it. No exceptions.

---

## 5. Observability is part of the feature.

Every accept/reject/dispatch decision emits an event on the SSE bus. The dashboard reads the bus; humans debug from the bus; correlation is by `traceId`. A feature that doesn't emit events isn't fully shipped.

**Implication 1**: New transports emit transport-specific lifecycle events (`socket.connected`, `socket.disconnected`, `webhook.accepted`, `schedule.fired`) plus the standard work-tracking events (`job.queued`, `job.started`, `job.completed`).

**Implication 2**: `traceId` flows from the ingress event through enqueue, dequeue, agent run, and run completion. Dashboards group by traceId; logs prefix with traceId. A run that loses its traceId is broken regardless of whether it produces correct output.

**Implication 3**: Secrets never appear in events or logs. Logging a 12-character hash of a prompt is fine; logging the prompt itself is debug-level only and never emitted to the bus.
