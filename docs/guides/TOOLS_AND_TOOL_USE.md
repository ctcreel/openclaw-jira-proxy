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
requires:
  - bot_token
```

Bash tools follow the same shape but the implementation is `impl.sh` and
declares its args/credentials via leading comment lines:

```bash
#!/usr/bin/env bash
# Args: ARG_CHANNEL, ARG_TEXT, ARG_THREAD_TS
# Optional: ARG_THREAD_TS
# Requires-Env: BOT_TOKEN
set -euo pipefail
…
```

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
          - module.bash:   winston_agent.shared.generate-something
```

Resolution rule: dots are directory separators; the leaf directory must
contain `tool.yaml`. Categories are optional — `winston_agent.standalone`
resolves to `winston_agent/standalone/`. Python references use only
identifier characters (no hyphens); bash references may use hyphens.

## What Clawndom does at boot

1. Reads each route's `tools:` list.
2. Resolves every entry to a directory containing `tool.yaml` + `impl.{py,sh}`.
3. Parses each `tool.yaml`.
4. Validates the helper's signature matches the YAML:
   - Python: parses `impl.py` with `ast.parse` (stdlib, no module import).
     `invoke()` must use kwarg-only params. Every YAML `args:` key must
     exist as a kwarg; required-ness must match no-default; optional-ness
     must match has-default; no extra kwargs allowed.
   - Bash: parses leading `# Args:` / `# Optional:` / `# Requires-Env:`
     comments and cross-checks against `tool.yaml`.
5. Any drift → boot fails fast with a clear error naming the divergence
   and the offending file path.

This is the single largest fuckup gate: you cannot ship a tool whose YAML
and helper disagree.

## What happens per invocation

When a route declares tools and the model emits a `tool_use` block:

1. Clawndom resolves each tool's `requires:` entries via the configured
   secrets strategy (`SECRETS_PROVIDERS_CONFIG`). Resolved values live in
   Clawndom's process address space only.
2. The executor spawns a subprocess for the chosen tool:
   - **Python:** `python3 -c "import json,sys,importlib; m = importlib.import_module('<ref>.impl'); print(json.dumps(m.invoke(**json.loads(sys.stdin.read()))))"` with args + credentials passed via stdin JSON.
   - **Bash:** the `impl.sh` script with `ARG_<NAME>` env vars for each arg
     and `<CREDNAME_UPPER>` env vars for each credential. Env is scoped to
     this subprocess.
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

## agent_version

At boot Clawndom captures git SHAs of every involved repository (its own
checkout, each agent's workspace repo, any sibling tool repos like
agency-tools) and composes a sha256 hash over sorted `name:sha\n` lines.
This hash is embedded in every audit record and surfaced at
`GET /api/version`. In `CLAWNDOM_ENV=production`, boot fails if any
involved repo has uncommitted changes — regulated buyers cannot
reproduce "what was running" if the state isn't fully in git.

## Status of runner integration

The route-side declarations, boot validation, executor, audit, and
versioning all ship with SPE-2078. The remaining piece — wiring the
`claude-cli` runner to register tool definitions with the Anthropic
tool-use API and call back into `executeToolCall` for each `tool_use`
block — is in flight. Until it lands, declared tools are validated at
boot but the model invocation path doesn't yet route through the
executor; templates that declare tools and run today will see the
tool definitions but the model won't have a working dispatch path.

The cleanest path forward for the runner integration is one of:

1. Extend `claude-cli.runner.ts` to accept `tools` in `RunOptions` and
   surface them via `claude-cli`'s MCP-server registration (Clawndom
   exposes itself as an MCP server that wraps the executor).
2. Add a new runner that uses the Anthropic SDK directly, bypassing
   `claude-cli` for routes that declare tools.

Either path is a focused follow-up rather than part of this change.

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
