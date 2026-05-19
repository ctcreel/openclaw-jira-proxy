# clawndom

An agent runtime for LLM agents that need to be auditable, declarative, and run per-tenant.

## What it is

clawndom runs one agent. The agent’s capabilities live in a separate git repo as a `clawndom.yaml` file plus markdown templates. clawndom reads that repo, accepts events from external sources (Slack, Jira, GitHub, Gmail, scheduled fires, internal dispatches), and routes each event to an LLM run that has exactly the tools the matching route declares — nothing more.

The runtime is per-agent. One systemd unit, one host, one log tree, one HTTP port per agent. Multi-tenancy is multiple side-by-side deployments, not multi-tenant in-process.

What you get from running it:

- A pluggable runner interface (`claude-cli`, `openai`, `bedrock`, `shell`, `null`) so the agent loop isn’t married to one LLM provider.
- Warm-subprocess session pooling with Redis-persisted session ids — conversations survive reaps, restarts, and quota walls via `claude --resume`.
- A least-privilege tool model: capability is per-route, credentials are per-tool, cred files are mode-600 and unlinked by the MCP server after read. Credentials never enter `process.env`, never appear in the prompt, never appear in `tool_use` definitions registered with the model.
- One NDJSON audit record per tool invocation with creds redacted, request_id and correlation_id propagated, agent version stamped.
- Completion-aware queue workers. The queue doesn’t release the next event until the current run has reached a terminal state — `ok`, `error`, `timeout`, or `quota_exceeded`. Quota walls don’t burn retries; they pause the queue, persist the session id, and resume the same conversation when the window opens.
- A built-in `Builder` system agent that can author PRs into the agent-workspace repo, so capability changes go through code review rather than ambient configuration drift.

## Why it exists

Most agent platforms in the wild are one of two things:

- Hosted SaaS where you trade control for convenience. The agent’s capabilities, memory, and execution all live in someone else’s tenant. Audit trail is whatever the vendor decides to expose. Credentials are connected at the org level and the agent uses what it can reach.
- A toy loop someone wrote in a notebook. Fine for one-off automations. Falls over the first time a webhook source sends a burst, a quota wall hits mid-run, a tool call needs a credential the prompt shouldn’t see, or someone asks what the agent actually did last Tuesday.

clawndom is the third option. It’s the runtime you build when:

- The agent touches data that has to be auditable. Healthcare-adjacent workflows. M&A-adjacent workflows. Anything where “what did the agent do, who authorized each tool call, what credentials did it touch, can you reproduce the run” is a question that will be asked.
- The agent is going to be a product, not just an internal tool. The agent’s capability spec needs to be a portable artifact — a workspace repo — that can be deployed for a different tenant without code changes.
- The capability surface should be enforced, not just documented. Adding a tool to the capability menu must give zero agents access until a route in some workspace opts it in. Templates must not be able to grant tool surface they weren’t declared with. The build breaks when these invariants are violated.
- Bursty event sources are normal. Jira board reorganizations fire ten events in two seconds. GitHub merges fan out into push, PR-close, deployment, status checks. The runtime serializes them, waits for actual completion, and bounds concurrent spend with a Redis semaphore.

If those constraints aren’t yours, you don’t need clawndom. Use a hosted product or write the notebook.

## Architectural shape

Three repos, by design:

```
clawndom            The runtime. TypeScript. This repo.

<agent-workspace>   The agent's complete capability spec. One repo per
                    agent (or a monorepo of agents). Carries clawndom.yaml,
                    templates/, SOUL.md. No executable code. The repo IS
                    the agent.

agency-tools        The Python tool menu. Each tool is a directory with
                    tool.yaml + impl.py. Inert until a route in some
                    agent-workspace opts it in.
```

An agent can do exactly what its routes declare. Nothing else.

- Templates don’t grant tools. They’re prose rendered against event payloads.
- agency-tools is a menu, not a deployment. Adding a tool there gives zero agents access until a route’s `tools:` block opts in.
- Credentials are scoped per-tool, injected at call time through a mode-600 file the MCP server reads then unlinks.

When you ask “why can’t this agent do X?”, the answer is always in some route’s `tools:` block. There is no other source.

For the load-bearing mental model — job lifecycle, runtime reality vs. design language, where things live on a deployed host — read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first. Everything else assumes you’ve read it.

## Runner abstraction

The agent loop isn’t married to one LLM provider. `AgentRunner` is a strategy-pattern interface; concrete implementations live in `src/runners/`:

|Runner      |When                                                                                                                                                                 |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`claude-cli`|Default. Spawns `claude` CLI with `--mcp-config`. Supports session resume, warm subprocess pooling, per-run system prompt for cache hits, quota-aware terminal state.|
|`openai`    |OpenAI-compatible endpoints. No session resume, no MCP.                                                                                                              |
|`bedrock`   |AWS Bedrock. No session resume, no MCP.                                                                                                                              |
|`shell`     |Per-rule maintenance commands. Used for `routing.schedule` rules that aren’t LLM calls. Not registered globally.                                                     |
|`null`      |Tests. Returns canned results.                                                                                                                                       |

Runner configs are a Zod-validated discriminated union. Adding a runner is a four-step recipe — see [`src/runners/README.md`](src/runners/README.md).

## Completion semantics

`RunResult.status` is one of `ok`, `error`, `timeout`, `quota_exceeded`. The worker treats each differently:

- `ok` → release the job, dequeue the next event.
- `error` → consume a retry attempt; standard BullMQ backoff.
- `timeout` → same.
- `quota_exceeded` → don’t consume a retry. Pause the queue until `quotaResetAt`. Persist the `session_id` captured from `system.init` onto the requeue envelope. When the queue resumes, the runner re-spawns with `claude --resume <id>` and continues the same conversation rather than replanning from scratch.

A Redis-backed global semaphore caps total concurrent runs across all providers (default: 1). The queue doesn’t acknowledge a job until `agent.wait` reports a terminal state — not just that the HTTP request returned.

## Security model

- One mode-700 scratch dir per run under the system temp directory.
- `tool-config.json` carries tool descriptors only (name, description, args schema). Readable by the run.
- `tool-creds.json` is mode-600. The Python MCP server reads it once at startup and unlinks it. Never re-read, never copied, never logged.
- Credentials never enter `process.env` of the runner subprocess. Only `CLAWNDOM_TOOL_CREDS_FILE` (the path) is injected.
- The model sees `mcp__clawndom-tools__<tool_name>` in its tool surface. Credentials are not part of any descriptor the model receives.
- `SecretManager` resolves credentials from configurable providers (env, 1Password, OAuth, file). Provider chain is set per-deployment in `SECRETS_PROVIDERS_CONFIG`.
- One NDJSON record per tool invocation appended to `audit.log`: timestamp, agent_id, route_id, tool_name, args (creds redacted), result_summary, error_summary, latency_ms, request_id, correlation_id, agent_version.

## Audit subsystem

Eleven static checks validate every agent-workspace before deployment. Run with `pnpm audit` against any workspace directory.

|Check                  |What it enforces                                                                             |
|-----------------------|---------------------------------------------------------------------------------------------|
|`condition-paths`      |Routing conditions reference fields that exist on the provider’s payload schema.             |
|`dispatch-declaration` |Internal dispatches name a `routing.internal` rule that actually exists.                     |
|`dispatch-tool-present`|Rules that emit dispatches declare the dispatch tool in their `tools:` block.                |
|`injection-targets`    |Template injection targets (`{{system-doc:…}}`, `{{system-shared:…}}`) resolve to real files.|
|`legacy-patterns`      |Catches deprecated config shapes from prior versions.                                        |
|`no-literal-mustache`  |Templates don’t contain literal `{{` that didn’t go through the renderer.                    |
|`rule-id-uniqueness`   |Rule ids are unique across all routing tables.                                               |
|`template-inputs`      |Every variable a template references is in the route’s resolved payload context.             |
|`templates-exist`      |Every `messageTemplate:` references a file that exists.                                      |
|`tool-use-declared`    |Tools referenced from templates are in the route’s `tools:` block.                           |

CI runs these on every push to the workspace repo. Builder can’t merge a PR that breaks them.

## What’s in the box

```
src/
  app.ts                  Composition root.
  server.ts               Startup wiring. The only place concrete
                          runners get instantiated.
  config.ts               Settings loading + provider config schemas.

  runners/                Pluggable AgentRunner implementations.
  strategies/             Signature validation, routing, session keys,
                          transports, payload schemas.
  services/               worker, scheduler, session-pool, memory,
                          audit, secrets, MCP bridge, event bus.
  controllers/            HTTP route handlers.
  middleware/             Auth, request context, error mapping.
  audit/                  Static checks + injection scan.
  system-agents/          Built-in agents that ship with the runtime.
                          Currently: Builder.

docs/
  ARCHITECTURE.md         Load-bearing mental model. Read first.
  REGULATED_BUYER_READINESS.md
  guides/                 TOOLS_AND_TOOL_USE, OPERATIONS template,
                          AGENT_WORKSPACE_LAYOUT, BRANCHING,
                          ENVIRONMENT_VARIABLES, SECRETS_MANAGEMENT.
  runners.md              Runner abstraction reference.
  design-patterns-guide.md

openspec/                 OpenSpec-format specs for every subsystem.
                          See "Specs" below.
```

## Specs

Behavior is defined in OpenSpec format under `openspec/specs/`. The runtime conforms to these; tests verify they’re satisfied; PRs that change behavior change the spec first.

|Spec                  |What it covers                                                                     |
|----------------------|-----------------------------------------------------------------------------------|
|`webhook-proxy-domain`|Ingestion, signature validation, queuing, completion-aware processing, concurrency.|
|`runner-abstraction`  |The `AgentRunner` interface and runner registry.                                   |
|`session-pool`        |Warm subprocess lifecycle, session id persistence, resume semantics.               |
|`tool-execution`      |MCP bridge, credential isolation, audit emission.                                  |
|`memory`              |Namespaced vector store, per-run rate limits, pruning.                             |
|`scheduler`           |Cron and fire-at scheduled tasks, Redis-backed records.                            |
|`audit-checks`        |The eleven static checks and the injection scan.                                   |
|`testing`             |Coverage thresholds, mock patterns.                                                |
|`error-handling`      |Exception hierarchy, RFC 7807 responses.                                           |
|`observability`       |Structured logging, health checks.                                                 |
|`infrastructure`      |systemd, Tailscale, Redis deployment.                                              |
|`ci-cd`               |GitHub Actions pipeline.                                                           |
|`enforcement`         |Pre-commit hooks, CI quality gates.                                                |

## Operating it

Per-agent deployment under systemd on a Tailscale-attached host. Each agent gets its own clone of clawndom, its own systemd unit, its own log tree, its own HTTP port.

```
/home/ubuntu/clawndom-<agent>/         Compiled clawndom (dist/server.js).
/etc/clawndom-<agent>/clawndom.env     Operator-provisioned env vars.
/etc/systemd/system/clawndom-<agent>.service
/var/log/clawndom-<agent>/
  clawndom.log                         Pino NDJSON. StandardOutput
                                       redirects here — not journalctl.
  audit.log                            Per-tool-call NDJSON.
/home/ubuntu/.clawndom-<agent>/agents/<owner>__<repo>/
                                       Live clone of the agent-workspace.
                                       Clawndom keeps this up to date.
                                       Its HEAD may be ahead of any local
                                       checkout — always verify live HEAD.
```

See [`docs/guides/OPERATIONS.md`](docs/guides/OPERATIONS.md) (generated per-deployment into the agent-workspace) for the runbook of any specific deployment.

## Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable`)
- Redis (BullMQ queue, semaphore, memory vector store cache, session-id persistence, scheduler records)
- Tailscale (deployment posture — public webhook routes terminate at Funnel; SSH happens over the tailnet)
- An agent-workspace repo with a valid `clawndom.yaml`

## Development

```
make dev          # Local server with hot reload.
make check        # Lint + test + security + naming.
make check-all    # Full validation. Required before commit.
make format       # Auto-fix formatting.
```

File size limits, coverage thresholds, and the naming-convention rules are enforced by the pre-commit hooks and CI. See [`CLAUDE.md`](CLAUDE.md) for the standards.

## License

Not yet licensed for external use. If you’re reading this and you’re not the author or an authorized contributor, the code is here for inspection, not redistribution.