# clawndom

An agent runtime for LLM agents that need to be auditable, declarative, and run per-tenant.

## What it is

clawndom is a TypeScript runtime that hosts one or more LLM agents in a single process. Each agent’s capabilities — its routes, tools, templates, schedules, memory bindings — are defined declaratively in a `clawndom.yaml` plus a directory of markdown templates that live in a separate git repo (the “workspace”). clawndom reads that repo at boot, audits it, and serves the agents it declares.

Per-deployment composition is set in `AGENTS_CONFIG`: a list of agent entries, each pointing at a workspace repo, an optional ref, and an optional sub-path within the repo. Two entries can share a repo (e.g. Patch and Scarlett both live in `the-agency`, at `workspaces/patch/` and `workspaces/scarlett/`). Two entries can also point at entirely different repos and run side-by-side in the same process. One process, N agents, one HTTP port, one log tree, one audit stream that carries `agent_id` on every record.

Inbound events arrive from Slack Socket Mode, HTTP webhooks (Jira, GitHub, Gmail Pub/Sub), scheduled cron fires, and internal dispatches from other agents. The matching agent’s matched route renders a template, builds an MCP bundle from the route’s declared tools, spawns the runner, and waits for the run to reach a terminal state before releasing the next event from the per-provider queue.

What you get from running it:

- A pluggable runner interface (`claude-cli`, `openai`, `bedrock`, `shell`, `null`, plus a legacy `openclaw`) so the agent loop isn’t married to one LLM provider.
- Warm-subprocess session pooling with Redis-persisted session ids — Claude CLI conversations survive idle reap, process restart, and quota walls via `claude --resume <id>`.
- A least-privilege tool model: capability is per-route, credentials are per-tool, cred files are mode-600 and unlinked by the MCP server after first read. Credentials never enter `process.env` of the runner subprocess, never appear in the prompt, never appear in tool descriptors registered with the model.
- One NDJSON audit record per tool invocation, with creds redacted, `request_id` and `correlation_id` propagated, and a composite `agent_version` hash stamped across every record so a row maps unambiguously to the exact code+config snapshot that produced it.
- Completion-aware queue workers. The queue doesn’t release the next event until the run reaches a terminal state — `ok`, `error`, `timeout`, or `quota_exceeded`. Quota walls don’t burn retries; they pause the queue until `quotaResetAt`, persist the session id, and resume the same conversation when the window opens.
- Boot-time workspace audit. The same static checks that gate CI run against every cloned workspace at startup. A workspace that fails an error-level check refuses to boot — fail-fast over a runtime that produces nothing but failed jobs.
- A `Builder` system agent that ships with the runtime and can author PRs into agent workspaces, so capability changes go through code review rather than ambient configuration drift.

## Why it exists

Most agent platforms in the wild are one of two things:

- Hosted SaaS where you trade control for convenience. The agent’s capabilities, memory, and execution all live in someone else’s tenant. Audit trail is whatever the vendor decides to expose. Credentials are connected at the org level and the agent uses what it can reach.
- A toy loop in a notebook. Fine for one-off automations. Falls over the first time a webhook source sends a burst, a quota wall hits mid-run, a tool call needs a credential the prompt shouldn’t see, or someone asks what the agent actually did last Tuesday.

clawndom is the third option. It’s the runtime you build when:

- The agent touches data that has to be auditable. Healthcare-adjacent workflows. M&A-adjacent workflows. Anything where “what did the agent do, who authorized each tool call, what credentials did it touch, can you reproduce the run” is a question that will be asked.
- The agent is going to be a product, not just an internal tool. The capability spec has to be a portable artifact — a workspace repo — that can be deployed for a different tenant without code changes.
- The capability surface has to be enforced, not just documented. Adding a tool to the tool menu must give zero agents access until a route in some workspace opts it in. Templates must not be able to grant tool surface they weren’t declared with. The build breaks when these invariants are violated.
- Bursty event sources are normal. Jira board reorganizations fire ten events in two seconds. GitHub merges fan out into push, PR-close, deployment, status checks. The runtime serializes them per-provider, waits for actual completion, and caps spend with a Redis-backed semaphore.

If those constraints aren’t yours, you don’t need clawndom. Use a hosted product or write the notebook.

## Architectural shape

Three repos, by design:

```
clawndom            The runtime. TypeScript. This repo.

<workspace>         A capability spec for one or more agents. Each
                    agent lives at workspaces/<agent>/ with its own
                    clawndom.yaml, templates/, SOUL.md. No executable
                    code. The repo IS the agent (or agents).

agency-tools        The Python tool menu. Each tool is a directory
                    with tool.yaml + impl.py. Inert until a route in
                    some workspace opts it in.
```

A deployment composes from this set via `AGENTS_CONFIG` — one entry per agent, each naming the workspace repo, optional ref, and the agent’s sub-path within the repo. Boot clones each unique repo once, validates that any two agents sharing a repo agree on `sharedTools` ref, runs the workspace audit against each agent, registers the runners each agent’s providers reference, and starts.

An agent can do exactly what its routes declare. Nothing else.

- Templates don’t grant tools. They’re prose rendered against event payloads.
- agency-tools is a menu, not a deployment. Adding a tool there gives zero agents access until a route’s `tools:` block opts in.
- Credentials are scoped per-tool, injected at call time through a mode-600 file the MCP server reads then unlinks.

When you ask “why can’t this agent do X?”, the answer is always in some route’s `tools:` block. There is no other source.

For the load-bearing mental model — job lifecycle, runtime reality vs. design language, where things live on a deployed host — read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first. Everything else assumes you’ve read it.

## Runner abstraction

The agent loop isn’t married to one LLM provider. `AgentRunner` is a strategy-pattern interface; concrete implementations live in `src/runners/`. The runtime only instantiates the runner types its loaded providers actually reference, so a `claude-cli`-only deployment doesn’t pull in the openclaw SDK or pay AWS boot cost.

|Runner      |Notes                                                                                                                                                                                                |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`claude-cli`|Default. Spawns the `claude` CLI with `--mcp-config`. Supports per-run system prompts (for prompt-cache hits), warm session pooling, `claude --resume <id>`, and the `quota_exceeded` terminal state.|
|`openai`    |OpenAI-compatible endpoints. No session resume, no MCP.                                                                                                                                              |
|`bedrock`   |AWS Bedrock. No session resume, no MCP.                                                                                                                                                              |
|`shell`     |Per-rule maintenance commands. Used for `routing.schedule` rules that aren’t LLM calls. Constructed per-firing, not registered globally.                                                             |
|`null`      |Tests. Returns canned results.                                                                                                                                                                       |
|`openclaw`  |Legacy. Dynamically imported so its SDK isn’t pulled in on hosts that don’t use it. New deployments should not use this runner.                                                                      |

Runner configs are a Zod-validated discriminated union on `type`. Adding a runner is a four-step recipe — see [`src/runners/README.md`](src/runners/README.md).

## Completion semantics

`RunResult.status` is one of `ok`, `error`, `timeout`, `quota_exceeded`. The worker treats each differently:

- `ok` → release the job, dequeue the next event.
- `error` → consume a retry attempt; standard BullMQ backoff.
- `timeout` → same.
- `quota_exceeded` → don’t consume a retry. Pause the queue until `quotaResetAt`. Persist the `session_id` captured from `claude-cli`’s `system.init` event onto the requeue envelope. When the queue resumes, the runner re-spawns with `claude --resume <id>` and continues the same conversation rather than replanning from scratch.

Workers run with `concurrency: 1` per provider. A Redis-backed global semaphore caps total concurrent runs across all providers (default: 1). The queue doesn’t acknowledge a job until the run reports terminal — not just that an HTTP request returned 202.

## HTTP surface

The HTTP API lives behind two distinct auth gates depending on the route’s purpose.

**Bearer-gated** (`Authorization: Bearer <CLAWNDOM_AGENT_TOKEN>`) — machine-to-machine surface. Used by agents dispatching tasks to each other, the version-stamping endpoint that the audit log correlates against, scheduled-tasks CRUD, the Builder deploy-complete callback, and the memory API:

- `POST /api/tasks` — inter-agent task dispatch. Plus `GET /api/tasks/:agent/:taskId` and `…/wait`.
- `GET /api/version` — `agent_version` hash plus per-repo breakdown.
- `/api/scheduled-tasks` — registry CRUD for cron and fire-at tasks.
- `/api/memory` — store/search/delete/prune on namespaces.
- `POST /webhooks/builder-deploy-complete` — Builder’s deploy-pipeline callback.

**Tailscale-identity-gated** — the editor-UI surface. Tailscale’s reverse proxy injects `Tailscale-User-Login`, `Tailscale-User-Name`, and optional profile-pic headers on tailnet requests, and the middleware fails closed (401) when they’re absent. An optional `EDITOR_TAILSCALE_ALLOWLIST` of emails enforces a further 403 gate, and setting it to `""` is the documented kill-switch (“nobody is allowed”). The middleware does not authenticate the request itself — Tailscale does; it enforces presence and allowlist on headers Tailscale already validated. **If the listen address is ever bound non-tailnet, the gate becomes meaningless**: an attacker can synthesize any header values. Deployments must keep the bind tailnet-only:

- `GET /api/schema/routing`
- `GET /api/workspace/:agent` and `…/template/*`
- `POST /api/workspace/:agent/audit` — on-demand audit run.
- `POST /api/workspace/:agent/edit` — PR-style write flow. Edits open a branch off `WORKSPACE_EDIT_BASE_BRANCH` (default `main`), commit as a configurable bot author (default `sc0red-patch[bot]`), and the operator’s tailnet identity flows into the audit record.

**Open surfaces** (no auth, intentional):

- `GET /api/health`, `GET /api/events` (SSE), `GET /api/jobs/active`, `GET /api/queue/snapshot`, `GET /api/webhooks/skipped/recent` — observability.
- `GET /api/tools/catalog`, `GET /api/agents/:agent/tools`, `GET /api/agents/:agent/context-schemas` — structural introspection. No secrets.
- `GET /api/agents/:agent/operations.md` — Markdown runbook rendered from live state. Called by a GH Action in each workspace repo that regenerates `OPERATIONS.md` on push-to-main. Carries no resolved tokens, no env values — only facts derivable from the workspace YAML.

Webhook routes (`/hooks/<provider>` per `transport: 'webhook'` provider) mount themselves through `WebhookTransport.mount()`. Slack Socket Mode providers don’t get HTTP routes — they open outbound websockets via `startTransports` after secrets resolve.

## Secrets and credentials

Credentials live in `SecretManager`, a strategy-pattern facade over four providers — env (`EnvSecretProvider`, always registered), 1Password (`OnePasswordProvider`), OAuth refresh-token grant (`OAuthSecretProvider`, used today for Claude OAuth), and file (`FileSecretProvider`). The provider chain is set per-deployment in `SECRETS_PROVIDERS_CONFIG`. Consumers call `getSecretManager().getSecret("key")` and never know which backend resolved it.

Three things matter beyond the provider plumbing:

**Refresh has a circuit breaker.** Bindings with TTLs get scheduled refreshes one minute before expiry. A refresh failure increments a per-group counter; three consecutive failures on a binding marked `required: true` exits the process with code 1, letting systemd restart it cleanly. Non-required bindings keep retrying without taking the process down.

**Resolved secrets cache to tmpfs.** `FileSecretCache` writes resolved values to `/run/clawndom/secrets.json` (mode 0600, owner-checked on read, atomic rename on write). The cache exists because of a real incident — a restart loop was re-shelling `op read` for every binding on every boot, ~720 restarts/hour × ~5 secrets, exhausted the 1Password service-account rate limit, and the rate-limit response became the new crash cause that locked the loop in. The systemd unit pairs the cache with a start-rate cap (`StartLimitBurst=5` over `StartLimitIntervalSec=300`) so a persistent boot failure can’t DoS upstream providers. Three invalidation triggers: per-entry TTL, global `maxAgeSeconds` ceiling, and operator escape hatch (delete the file). `RuntimeDirectoryPreserve=restart` means the cache survives `systemctl restart` but is wiped on `stop` or host reboot.

**Boot validation before workers start.** `validateProviderEnvSecrets` and `validateSlackSocketSecrets` run before any worker spins up. A Slack-socket provider whose `appTokenSecret` or `botTokenSecret` references an undeclared key fails boot with the misconfigured field named — instead of failing at the first outbound reply attempt.

## Security model — agent runs

- One mode-700 scratch dir per run.
- `tool-config.json` carries tool descriptors only — name, description, args schema. The model sees these via MCP.
- `tool-creds.json` is mode-600. The Python MCP server reads it once at startup and unlinks it. Never re-read, never copied, never logged.
- Credentials never enter `process.env` of the runner subprocess. Only `CLAWNDOM_TOOL_CREDS_FILE` (the path to the cred file) is injected.
- The model sees `mcp__clawndom-tools__<tool_name>` in its tool surface. Credentials are not part of any descriptor the model receives.
- One NDJSON record per tool invocation appended to `audit.log`: timestamp, agent_id, route_id, tool_name, args (creds redacted), result_summary, error_summary, latency_ms, request_id, correlation_id, agent_version.
- In `CLAWNDOM_ENV=production`, boot fails if any agent’s repo has uncommitted changes, so the `agent_version` hash always maps back to a committed snapshot.

For the regulated-buyer angle in full, see [`docs/REGULATED_BUYER_READINESS.md`](docs/REGULATED_BUYER_READINESS.md).

## Memory

Memory is declared per-namespace in each agent’s `clawndom.yaml` under `memory.namespaces.<name>`. Each namespace names an embedding provider (`openai`, `null`), a vector store (`redis`, `in-memory`), a `pruneAfter` threshold, and a `maxStoresPerRun` rate limit. Bootstrap is lazy: only namespaces actually declared register their providers, so a deployment with no memory-using agents doesn’t require the OpenAI key.

The `MemoryService` exposes store, search, delete, prune to two consumers: the HTTP `/api/memory` controller (bearer-gated, used by agents calling memory as a tool) and the worker’s pre-render hook (which fetches relevant memories before rendering the route’s template). Per-run rate limiting tracks store calls per `(traceId, namespace)`; entries age out ten minutes after last touch so the limit doesn’t become a global counter.

How memory reaches the model: when a route declares a memory namespace, the worker prepends a “Memory — durable facts you know about this conversation” block with the pre-fetched hits interpolated, and appends a “recording new durable facts” block that explains to the model what’s worth storing. Both blocks ship inside the clawndom bundle as TS template strings — a memory-UX improvement deploys without any agent-repo PR.

The Redis vector store uses vanilla Redis primitives, not RediSearch — hashes for entries plus a per-namespace SET as the index, brute-force linear scan at search time. The trade-off was explicit: lowest-common-denominator Redis over the `redis-stack` image dependency. Fine at thousands-of-entries scale; swap in RediSearch behind the same `VectorStore` interface if it ever stops being fine.

## Workspace audit

Static checks validate every workspace before deployment. They run at CI time on the workspace repo, and again at clawndom boot against each cloned workspace. Boot fails when an error-level check fails on any loaded agent.

The checks live in `src/audit/checks/`:

|Check                  |What it enforces                                                                          |
|-----------------------|------------------------------------------------------------------------------------------|
|`condition-paths`      |Routing conditions reference fields that exist on the provider’s payload schema.          |
|`dispatch-declaration` |Internal dispatches name a `routing.internal` rule that exists.                           |
|`dispatch-tool-present`|Rules that emit dispatches declare the dispatch tool in their `tools:` block.             |
|`injection-targets`    |Template injection tags (`{{system-doc:…}}`, `{{system-shared:…}}`) resolve to real files.|
|`legacy-patterns`      |Catches deprecated config shapes from prior versions.                                     |
|`no-literal-mustache`  |Templates don’t contain literal `{{` that didn’t go through the renderer.                 |
|`rule-id-uniqueness`   |Rule ids are unique across all routing tables.                                            |
|`template-inputs`      |Every variable a template references is in the route’s resolved payload context.          |
|`templates-exist`      |Every `messageTemplate:` references a file that exists.                                   |
|`tool-use-declared`    |Tools referenced from templates are in the route’s `tools:` block.                        |

Plus an injection scanner that flags shapes that look like attempts to override the system prompt or escape the rendered template.

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
                          secrets, MCP bridge, event bus, scheduled
                          tasks, orphan reaper.
  controllers/            HTTP route handlers.
  middleware/             Auth, request context, error mapping.
  audit/                  Static checks + injection scan.
  secrets/                SecretManager + env/1Password/OAuth/file
                          providers + tmpfs file cache.
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

openspec/specs/           OpenSpec specs the runtime conforms to.
                          See "Specs" below.
```

## Specs

Behavior is defined in OpenSpec format under `openspec/specs/`. The runtime conforms to these; tests verify they’re satisfied; PRs that change behavior change the spec first.

|Spec                   |What it covers                                                                                |
|-----------------------|----------------------------------------------------------------------------------------------|
|`webhook-proxy-domain` |Inbound ingestion, signature validation, queuing, completion-aware processing, concurrency.   |
|`agent-runner-strategy`|The `AgentRunner` interface and runner registry.                                              |
|`agent-tool-use`       |MCP bridge, tool descriptors, credential isolation, audit emission.                           |
|`agent-versioning`     |Composite `agent_version` hashing across involved repos; boot-time clean-checkout enforcement.|
|`api-design`           |HTTP response contracts (RFC 7807 errors).                                                    |
|`code-architecture`    |Layered architecture, file size limits, dependency direction.                                 |
|`error-handling`       |Exception hierarchy, structured error responses.                                              |
|`observability`        |Structured logging, health checks.                                                            |
|`infrastructure`       |systemd, Tailscale, Redis deployment.                                                         |
|`ci-cd`                |GitHub Actions pipeline.                                                                      |
|`enforcement`          |Pre-commit hooks, CI quality gates.                                                           |
|`quality-framework`    |Coverage thresholds, principles.                                                              |
|`developer-experience` |Makefile, tooling, onboarding.                                                                |
|`testing`              |Test strategy, coverage thresholds, mock patterns.                                            |

## Operating it

Deployed as a single systemd unit running one node process. The base unit is `clawndom.service`; in multi-deployment setups (running clawndom for both `winston` and `the-agency` on the same host) the units are named by convention — `clawndom-winston.service`, `clawndom-the-agency.service` — each with its own repo clone, env file, log dir, and HTTP port. The naming is convention, not a runtime requirement; the runtime just sees one process per deployment.

```
/opt/clawndom/                          Compiled clawndom (dist/server.js).
                                        Or /home/ubuntu/clawndom-<name>/
                                        in the per-deployment convention.
/etc/clawndom/clawndom.env              Operator-provisioned env vars.
/etc/systemd/system/clawndom.service
/var/log/clawndom/
  clawndom.log                          Pino NDJSON. StandardOutput
                                        redirects here — not journalctl.
  audit.log                             Per-tool-call NDJSON.
/run/clawndom/                          Tmpfs secret cache (mode 0700,
                                        preserved across restart, wiped
                                        on stop or host reboot).
<configDir>/<owner>__<repo>/            Live clone of each workspace repo
                                        the deployment loads. clawndom
                                        keeps these up to date. HEAD may
                                        be ahead of any local checkout —
                                        always verify live HEAD.
```

The systemd unit caps start rate (`StartLimitIntervalSec=300`, `StartLimitBurst=5`) so a persistent boot failure doesn’t DoS upstream secret resolvers. It also caps memory at the cgroup level so a runaway warm-session subprocess gets OOM-killed inside the unit rather than wedging the host.

See [`docs/guides/OPERATIONS.md`](docs/guides/OPERATIONS.md) (generated per-deployment into each workspace) for the runbook of any specific deployment.

## Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable`)
- Redis (BullMQ queue, semaphore, memory vector store cache, session-id persistence, scheduler records)
- Tailscale (public webhook routes terminate at Funnel; SSH happens over the tailnet)
- One or more workspace repos with valid `clawndom.yaml` files

## Development

```
make dev          # Local server with hot reload.
make check        # Lint + test + security + naming.
make check-all    # Full validation. Required before commit.
make format       # Auto-fix formatting.
```

File size limits, coverage thresholds, and naming conventions are enforced by pre-commit hooks and CI. See [`CLAUDE.md`](CLAUDE.md) for the standards.

## License

Not yet licensed for external use. The code is public for inspection, not redistribution.