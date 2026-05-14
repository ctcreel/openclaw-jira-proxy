# Tools and Tool Use (SPE-2078)

This guide explains how Clawndom dispatches per-route tool calls under the
credential-agent pattern introduced in SPE-2078. Read alongside
`openspec/changes/spe-2078-tool-use/proposal.md` and `design.md` for the
why.

## The shape of a tool

Each tool is a directory containing two files:

```
agency_tools/slack/post/
  tool.yaml      # description, args schema, requires (credentials), optional name override
  impl.py        # def invoke(*, channel, text, thread_ts=None, blocks=None, bot_token): ...
```

`tool.yaml`:

```yaml
description: Post a message to a Slack channel.
args:
  channel:
    type: string
    description: Slack channel ID.
  text:
    type: string
    description: Message text.
  thread_ts:
    type: string
    description: When present, posts as a thread reply.
    optional: true
secrets:
  # `bot_token` is the kwarg name `invoke()` receives.
  # Operators may wire either env name in SECRETS_CONFIG; first-match wins.
  bot_token: [SLACK_WINSTON_BOT_TOKEN, SLACK_BOT_TOKEN]
```

For tools that only need a single alias, the shorthand `bot_token: SLACK_BOT_TOKEN` is equivalent to `bot_token: [SLACK_BOT_TOKEN]`.

## Declaring tools on a route

In `clawndom.yaml`:

```yaml
routing:
  slack-winston:
    rules:
      - name: chat
        condition: { … }
        messageTemplate: templates/slack-chat.md
        tools:
          - module.python: agency_tools.slack.post
          - module.python: agency_tools.slack.conversations_replies
```

Resolution rule: dots are directory separators; the leaf directory must
contain `tool.yaml`. Categories are optional — `winston_agent.standalone`
resolves to `winston_agent/standalone/`. References use only Python
identifier characters (no hyphens).

The schema is extensible to additional `module.<lang>:` keys (e.g.
`module.rust:`) by registering a new executor. Today only Python tools
are first-class.

## What Clawndom does at boot

1. Reads each route's `tools:` list.
2. Resolves every entry to a directory containing `tool.yaml` + `impl.py`.
3. Parses each `tool.yaml`.
4. Validates the helper's signature matches the YAML by parsing `impl.py`
   with Python's stdlib `ast` module (no module import, no top-level
   execution). `invoke()` must use kwarg-only params. Every YAML `args:`
   key must exist as a kwarg; required-ness must match no-default;
   optional-ness must match has-default; every `secrets:` canonical name
   must exist as a kwarg with no default (credentials are always
   injected); no extra kwargs allowed.
5. Validates that for each `secrets:` entry, at least one declared alias
   is registered in `SECRETS_CONFIG`. Operators see a clear list of
   acceptable binding keys when a tool can't be resolved.
5. Any drift → boot fails fast with a clear error naming the divergence
   and the offending file path.

This is the single largest fuckup gate: you cannot ship a tool whose YAML
and helper disagree.

## What happens per invocation

When a route declares tools and the model emits a `tool_use` block:

1. Clawndom resolves each tool's `secrets:` entries: for each canonical
   name, the resolver walks its alias list in order and uses the first
   registered binding from the configured secrets strategy
   (`SECRETS_PROVIDERS_CONFIG`). The resolved value is keyed by the
   canonical name in the per-tool credentials map. Resolved values live
   in Clawndom's process address space only.
2. The executor spawns a Python subprocess for the chosen tool:
   `<python> -c "import json,sys,importlib; m = importlib.import_module('<ref>.impl'); print(json.dumps(m.invoke(**json.loads(sys.stdin.read()))))"`
   with args + credentials passed via stdin JSON. The Python binary
   defaults to `python3` and is overridable via `CLAWNDOM_PYTHON_BINARY`
   (set this when the venv isn't on PATH).
3. Stdout is parsed as the JSON `tool_result`. Stderr contributes to
   `error_summary` on non-zero exit. 30s default timeout
   (SIGTERM-then-SIGKILL).
4. Exactly one audit record is written via `writeAuditRecord` to the
   configured audit log path (default `/var/log/clawndom-winston/audit.log`,
   override `CLAWNDOM_AUDIT_LOG`). The record carries timestamp, agent_id,
   route_id, tool_name, args (credentials redacted by exact-match),
   result_summary, error_summary, latency_ms, request_id, correlation_id
   (defaults to request_id), and agent_version.

Credentials are never:
- in the rendered system prompt
- in the rendered user prompt
- in the agent's process environment
- visible in the `tool_use` definition registered with the Anthropic API
- present unredacted in audit records

## Configuration env vars

| Var | Default | Purpose |
|---|---|---|
| `CLAWNDOM_PYTHON_BINARY` | `python3` (PATH) | Python interpreter for boot-time signature validation, runtime dispatch, and the MCP server. Set when the venv isn't on PATH (e.g. `/home/ubuntu/clawndom-venv/bin/python`). |
| `CLAWNDOM_AUDIT_LOG` | `/var/log/clawndom-winston/audit.log` | NDJSON audit log path. Per-invocation records append here. |
| `CLAWNDOM_MCP_SERVER_SCRIPT` | resolved from layout | Absolute path to `scripts/clawndom_mcp_server.py`. Override when the bundled binary's auto-detection fails (e.g. in a Docker image with a non-standard layout). |
| `CLAWNDOM_ENV` | `development` | Set to `production` to fail boot on dirty repos (so `agent_version` is reproducible). |

## agent_version

At boot Clawndom captures git SHAs of every involved repository (its own
checkout, each agent's workspace repo, any sibling tool repos like
agency-tools) and composes a sha256 hash over sorted `name:sha\n` lines.
This hash is embedded in every audit record and surfaced at
`GET /api/version`. In `CLAWNDOM_ENV=production`, boot fails if any
involved repo has uncommitted changes — regulated buyers cannot
reproduce "what was running" if the state isn't fully in git.

## Migrating an existing template

Before SPE-2078, templates that called Slack helpers shelled out to
python3 via bash heredocs, with the bot token read from
`os.environ['SLACK_WINSTON_BOT_TOKEN']`. Migration to SPE-2078:

1. Declare the tools on the route (`tools:` block in `clawndom.yaml`).
2. Remove the `bash <<'PY' … PY` heredoc invocations from the template.
3. Remove all `os.environ['SLACK_…_BOT_TOKEN']` references.
4. Restructure prose to describe the new structured `tool_use` flow —
   the agent emits tool_use blocks; Clawndom dispatches; results come
   back as `tool_result`. See `workspaces/winston/templates/slack-chat.md`
   in `winston-agency` for the canonical example.

Other Winston templates that use Google service-account auth (Gmail,
Calendar, Tasks) keep the bash-heredoc pattern for now — service-account
JSON files on disk are a different credential model than env-var tokens
and are not load-bearing for the credential-agent pattern. Migration of
those templates lands when the Google APIs are restructured into per-tool
directories (separate change).
