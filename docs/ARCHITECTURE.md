# Clawndom — Architecture

Read this first. It is the load-bearing mental model for everything else in `docs/`.

## First five minutes (cold start checklist)

Before reasoning about any clawndom behavior, in order:

1. **Identify the agent.** `winston`? `patch`? `scarlett`? The deployment is per-agent — one systemd unit, one log tree, one tailnet host.
2. **Find the live deployed config**, not your local checkout. SSH `ubuntu@<host>` and read `/home/ubuntu/.clawndom-<agent>/agents/<owner>__<repo>/workspaces/<agent>/clawndom.yaml`. The live HEAD may be commits ahead of your local — Builder-authored PRs land autonomously.
3. **Tail the right log.** `sudo tail -f /var/log/clawndom-<agent>/clawndom.log` (NOT journalctl — `StandardOutput` redirects to this file). Audit log at `audit.log` next to it has one record per tool call.
4. **Answer "what can this agent do?" from the route's `tools:` block.** That is the only source of truth. Not templates, not agency-tools, not SOUL.md.

These four steps prevent ~80% of the wrong assumptions I make when walking in cold.

## Anti-patterns (don't do these)

I have made each of these mistakes. The doc is here so future-me doesn't repeat them.

- **Don't read templates to figure out tool surface.** Templates are prose rendered against event payloads. They don't define or grant tools. If you find yourself reading `slack-chat.md` to answer "can Winston send email from Slack?", stop. Read the `slack-winston` route's `tools:` block.
- **Don't trust your local agent-workspace checkout.** Always `git -C <live-checkout> rev-parse HEAD` on the host first. Build-bots PR autonomously.
- **Don't conflate `agency-tools` adds with capability grants.** Adding `agency_tools.foo.bar/` gives ZERO agents access. A route declaring it does.
- **Don't translate `TOOLS_AND_TOOL_USE.md` literally.** It describes the SPE-2078 design in terms of "Anthropic tool_use API." The runtime uses MCP via claude-cli (see "Runtime reality" below). Same outcome, different wire — but the difference matters when reading logs.
- **Don't grep journalctl for clawndom errors.** `StandardOutput=append:/var/log/...` redirects everything to the file. journalctl shows only systemd lifecycle events.
- **Don't assume `type: integer` works in `tool.yaml`.** SPE-2078's schema rejects it — use `type: number`. Some existing tools (e.g. `aws.cloudwatch.filter_logs`) still declare `integer` and would crash boot if a route opted in.

## The three repos

The whole system lives across three repositories. Holding the wrong split in your head will mislead every subsequent doc you read.

```
clawndom            ← THIS repo. The TypeScript runtime. Routes,
                      workers, runners, MCP bridge, scheduler, secrets,
                      memory, audit. The thing that runs as a node
                      process under systemd on each deployed host.

<agent-workspace>   ← Per-agent declarative definitions. One repo per
  e.g. winston-agency  agent product (or a multi-agent monorepo, see
       the-agency       below). Carries `clawndom.yaml` (routes,
                       tools, schedules) plus markdown templates
                       (`templates/*.md`). NO executable code. The
                       repo IS the agent's complete capability spec —
                       Clawndom reads it; nothing else grants the
                       agent any capability.

agency-tools        ← The Python tool *menu*. Each tool is a directory
                      containing `tool.yaml` + `impl.py`. Agents don't
                      know about tools until a route in some agent-
                      workspace's `clawndom.yaml` opts the tool in
                      with `module.python: agency_tools.<path>`.
                      Adding a tool here is inert until a route
                      declares it.
```

A single-agent workspace looks like `winston-agency/workspaces/winston/{clawndom.yaml,templates/,SOUL.md,...}`. A multi-agent workspace looks like `the-agency/workspaces/{patch,scarlett,shared}/...`. The workspace shape is `workspaces/<agent>/` regardless.

## The least-privilege model

**An agent can do exactly what its routes declare. Nothing else.**

- Templates do NOT enumerate or grant tools. They're prose rendered against the inbound event payload; their tool surface is whatever the *route* declares.
- `agency-tools` is a *capability menu*, not a deployment of capabilities. Adding a tool there gives zero agents access until a route's `tools:` block opts in.
- Credentials are scoped per-tool via `secrets:` in each `tool.yaml` and injected at call time through a mode-600 file the MCP server reads then unlinks. They never enter the agent's `process.env`, never appear in the prompt, never appear in `tool_use` definitions registered with the model.

When debugging "why can't the agent do X?", the answer is *always* in some route's `tools:` block in the agent's `clawndom.yaml`. There is no other source.

## Job lifecycle

A canonical job — say, a Slack DM arriving at Winston:

```
1. Inbound event
   • Slack Socket Mode WebSocket delivers an `event_callback` to
     clawndom's slack-socket-transport (one of several inbound
     transports — also HTTP webhooks, OIDC-signed Pub/Sub pushes,
     scheduler fires).

2. Provider routing
   • Each inbound provider has rules: condition → matched rule.
     For Slack, conditions are JSON-path predicates over the event
     payload (event.type == "message", event.channel_type == "im",
     no event.bot_id, …). One rule wins.

3. Enqueue
   • The matched rule, the event payload, and the resolved agent's
     workspace directory all get wrapped into a job and pushed onto
     a BullMQ queue keyed by `<agent>-<provider>`.

4. Worker pickup (src/services/worker.service.ts)
   • Worker dequeues, renders the route's `messageTemplate` against
     the payload (Liquid-ish syntax — see src/lib/template/), resolves
     memory recall if `memory:` is declared, builds the MCP bundle
     from the route's `tools:` block.

5. MCP bundle (src/services/tools/mcp-bridge.ts)
   • Per-run, writes a mode-700 scratch dir:
       - tool-config.json    descriptors only (name, description,
                             args schema, references)
       - tool-creds.json     resolved credential values, mode-600,
                             read+unlinked by the MCP server
       - mcp-config.json     {mcpServers: {clawndom-tools: {…}}}
   • Resolves each tool's secrets via SecretManager (env, 1Password,
     OAuth, or file providers, configured per-deployment in
     SECRETS_PROVIDERS_CONFIG).

6. Spawn (src/runners/claude-cli.runner.ts)
   • Spawns `claude` CLI with `--mcp-config <path>` plus an env carrying
     CLAWNDOM_TOOL_CREDS_FILE (the path to creds; never the values),
     CLAWNDOM_AGENT_ID, CLAWNDOM_REQUEST_ID, CLAWNDOM_ROUTE_ID,
     CLAWNDOM_AGENT_VERSION.

7. MCP tool discovery (claude-cli ↔ python MCP server)
   • claude-cli queries MCP `tools/list`. Python server
     (scripts/clawndom_mcp_server.py) reads tool-config.json and
     responds with each tool's descriptor. Model registers them as
     `mcp__clawndom-tools__<tool_name>` and decides when to call.

8. Tool execution (src/services/tools/executor.ts)
   • When the model emits a tool_use, the Python MCP server spawns
     `python -c "...importlib.import_module(<ref>.impl).invoke(**args)..."`
     with args + credentials piped via stdin. Stdout → tool_result.
     30s default timeout.

9. Audit (src/services/audit/)
   • Exactly one record per tool invocation appended to
     /var/log/clawndom-<agent>/audit.log. Carries timestamp,
     agent_id, route_id, tool_name, args (creds redacted),
     result_summary, error_summary, latency_ms, request_id,
     correlation_id, agent_version.

10. Result
    • claude-cli streams assistant_text / tool_call / result events.
      Worker parses, emits SSE to subscribers, records run usage.
```

## Runtime reality vs. design language

`docs/guides/TOOLS_AND_TOOL_USE.md` describes the SPE-2078 design in terms of Anthropic's tool_use API. **The runtime actually uses MCP**, not direct Anthropic tool_use. The translation happens in `claude-cli`:

- Clawndom emits MCP descriptors. claude-cli serves them to the model as MCP tools.
- The model sees `mcp__clawndom-tools__<tool_name>` in its tool surface (visible in audit log).
- When the model calls one, claude-cli's MCP client forwards the call to the Python MCP server, which dispatches to `<ref>.impl.invoke(**args)`.

Net effect is identical to direct tool_use, but the wire is MCP. When reading `TOOLS_AND_TOOL_USE.md`, mentally translate "Anthropic tool_use API" → "MCP-via-claude-cli."

## Where things live on a deployed host

```
/home/ubuntu/clawndom-<agent>/      Compiled clawndom (dist/server.js)
/etc/clawndom-<agent>/clawndom.env  Operator-provisioned env vars (port,
                                    secret-provider config, agent token)
/etc/systemd/system/clawndom-<agent>.service
                                    Systemd unit. Restart=always,
                                    StandardOutput=append:/var/log/...
/var/log/clawndom-<agent>/
  clawndom.log                      stdout+stderr Pino NDJSON. Tail
                                    THIS for boot errors, not journalctl
                                    (StandardOutput redirects).
  audit.log                         Per-tool-call NDJSON audit.
/home/ubuntu/.clawndom-<agent>/agents/<owner>__<repo>/
                                    Live clone of the agent-workspace
                                    repo. Clawndom keeps this up to
                                    date. Its HEAD may be AHEAD of any
                                    local working copy — always check
                                    live HEAD before reasoning about
                                    deployed config.
```

The HTTP API listens on the port from `clawndom.env` (default `8794`). Each deployment is per-agent: one clone of clawndom, one systemd unit, one log tree, one HTTP port. There is no multi-agent process; multi-tenancy is achieved by running multiple clawndom instances side-by-side or, more commonly, on per-tenant EC2 instances.

## Doc tree

```
clawndom/
  CLAUDE.md                          Project standards (TS rules, file
                                     size limits, coverage gate).
  docs/
    ARCHITECTURE.md                  ← you are here
    guides/
      TOOLS_AND_TOOL_USE.md          SPE-2078 design language. Translate
                                     "Anthropic tool_use" → MCP at runtime.
      OPERATIONS.md                  Per-agent runbook. *Generated* —
                                     each agent-workspace gets its own
                                     OPERATIONS.md committed at the
                                     workspace root by a GH Action.
      AGENT_WORKSPACE_LAYOUT.md
      BRANCHING.md
      ENVIRONMENT_VARIABLES.md
      SECRETS_MANAGEMENT.md
    runners.md                       Runner abstraction (claude-cli,
                                     openai, bedrock, openclaw, null).
    design-patterns-guide.md         Internal idioms (retries, caching,
                                     structured logging, request ctx).
agency-tools/
  AGENCY_TOOLS_CATALOG.md            Generated. The capability menu —
                                     every tool's name, description,
                                     args, secrets. Refreshed on push
                                     to main.
<agent-workspace>/
  workspaces/<agent>/
    clawndom.yaml                    The agent's complete capability
                                     spec. THE source of truth for
                                     what this agent can do.
    OPERATIONS.md                    Generated. Per-deployment runbook
                                     (port, log paths, route summary,
                                     scheduled tasks, live HEAD).
    SOUL.md                          Voice / principles (optional;
                                     injected as IDENTITY in templates
                                     unless `identity.soul: false`).
    templates/*.md                   Prompt templates rendered per job.
```

## Common debug entry points

| Symptom | Where to look |
|---|---|
| "Agent says it can't do X" | The route's `tools:` block in the workspace's `clawndom.yaml`. Live deployed copy, not your local checkout (live HEAD often ahead). |
| Boot loop | `/var/log/clawndom-<agent>/clawndom.log` on the host (NOT journalctl). Grep for `Failed to start server`. |
| Tool resolution failure | Same log. Validator's error names the file path it expected. Common: tool dir missing on agency-tools, or `tool.yaml` uses `integer` (the SPE-2078 schema rejects it; use `number`). |
| Tool runs but errors at call time | `/var/log/clawndom-<agent>/audit.log` carries `error_summary`. Common: missing env var the `impl.py` reads (`CLAWNDOM_AGENT_TOKEN`, `CLAWNDOM_REQUEST_ID`, etc.) — check `src/services/tools/mcp-bridge.ts` for the actual injected set. |
| Scheduled prompt fires but no-ops | The schedule call must pass `tools=` at scheduling time; without it the fire-time runner only has claude-cli built-ins. See `agency_tools/scheduled_tasks/schedule/`. |
| "What does the model literally see?" | Audit log will show `tool: mcp__clawndom-tools__<name>` per call. The full descriptor is in the per-run scratch `/tmp/clawndom-mcp-*/tool-config.json` while the job runs. |

## Hosts

Live Clawndom deployments are reachable over Tailscale. SSH as `ubuntu@<hostname>` (NOT `ec2-user` — Tailscale SSH errors with `failed to look up local user` for any other name on a stock Ubuntu EC2). Each agent workspace's `OPERATIONS.md` carries its host's name and ops facts.
