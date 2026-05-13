# Agent workspace layout

Canonical directory shape for an agent workspace consumed by Clawndom. New agents start from this skeleton; existing agents are expected to match it.

## Required skeleton

```
workspaces/<agent>/
  clawndom.yaml          ← routing rules + memory namespaces (top-level config)
  docs/                  ← every doc-injection target
    IDENTITY.md          ← who the agent is, who they work with
    SOUL.md              ← voice, principles, do/don't
    <other-docs>.md      ← agent-specific reference material
    <data-files>.json    ← structured data the agent reads (e.g. team rosters, label maps)
  templates/             ← Nunjucks templates dispatched by routing rules
    *.md
```

Every file referenced by a template via `{{system-doc:...}}` or `{{doc:...}}` lives under `docs/`. The injection path is always `docs/<file>`, never a bare filename at the workspace root. Structured data (`team.json`, label maps, etc.) goes in `docs/` alongside the prose so the injection-path shape stays uniform.

### Why everything under `docs/`

The renderer accepts `{{system-doc:<anything>}}` against the workspace root, so a file at `workspaces/<agent>/team.json` is reachable as `{{system-doc:team.json}}`. It works, but it splits the mental model: the model author sees `{{system-doc:docs/IDENTITY.md}}` next to `{{system-doc:team.json}}` and has to remember the second one is a workspace-root special case. Keep everything under `docs/` so the injection prefix is always `docs/`.

## Required files

| File | Purpose |
|---|---|
| `clawndom.yaml` | Routing rules: schedule (cron), webhook (per-provider rules with conditions), internal (`taskType → template`), plus `modelRules` and per-route `tools:` declarations. Memory namespaces declared at the top. |
| `docs/IDENTITY.md` | Who the agent is: name, role, who they work with, what mailboxes/channels they touch. Injected into every template via `{{system-doc:docs/IDENTITY.md}}`. |
| `docs/SOUL.md` | Engineering / voice / interaction principles. Sets behavior, not capability. |

## Optional layout variants

### Variant A — single-agent repo (e.g., winston-agency)

```
winston-agency/
  README.md
  workspaces/winston/
    clawndom.yaml
    docs/
    templates/
```

No `workspaces/shared/`. The agent's shared library lives in a separate repo (e.g., `agency-tools`), pulled by Clawndom at boot via `AGENTS_CONFIG.sharedTools.{repo, ref, path}`. The clone lands next to the agent at runtime so templates can reference shared tool modules in route declarations (`tools: - module.python: agency_tools.google.gmail_send`).

Use this variant when:
- The repo houses a single agent (or agents that don't share prose docs).
- The shared library is a separately-versioned package (Python, npm, etc.) with its own release cadence.
- The agent's host has any compliance / isolation constraint (HIPAA, separate AWS account) that argues for a separately-deployed repo.

### Variant B — multi-agent repo with in-tree shared/ (e.g., the-agency)

```
the-agency/
  README.md
  workspaces/
    shared/
      docs/              ← engineering pipeline, anti-patterns, writing-great-*, etc.
      tools/             ← operator scripts (token fetch, workflow dumps)
    <agent-a>/
      clawndom.yaml
      docs/
      templates/
    <agent-b>/
      clawndom.yaml
      docs/
      templates/
```

`workspaces/shared/docs/` is injected via the `{{system-shared:docs/...}}` prefix (vs `{{system-doc:docs/...}}` for per-agent files). `workspaces/shared/tools/` holds operator scripts the agents shell out to (token generation, workflow dumps).

Use this variant when:
- Two or more agents in the repo share substantial prose (engineering pipeline, writing guides, auth patterns).
- The shared content is tightly coupled to its consumers and versioning it separately would create coordination overhead.

## Cross-cutting expectations

Regardless of variant:

- **No `CLAUDE.md` per agent.** The Claude CLI auto-loads any `CLAUDE.md` in the cwd into the system prompt, which would inject content Clawndom didn't explicitly choose on every hook session. Use the template + injection mechanism instead so Clawndom owns the prompt byte-for-byte.
- **Avoid literal `{{` inside injected docs.** Nunjucks renders the system slot too; a literal `{{` inside an injected doc gets parsed as a template tag and the render fails. Describe template syntax in prose rather than showing literal examples.
- **Per-route `tools:` declarations** in `clawndom.yaml` are the authoritative list of what the agent can call on a given route. Templates emit `tool_use` blocks against those tools; Clawndom registers them with the Anthropic tool-use API at job start.

## What does NOT belong in the workspace

- Compiled artifacts, Python `__pycache__`, build output. The workspace is source-of-truth, not a build target.
- Per-host config (port numbers, file paths, secrets references). That lives in Clawndom's `clawndom.env` on each host.
- One-off scripts that ran once. Operator scripts that templates invoke at runtime belong in `workspaces/shared/tools/` (Variant B) or in the external shared library (Variant A).

## Migration from non-canonical layouts

If you find a file at `workspaces/<agent>/<file>` that templates inject via `{{system-doc:<file>}}`, move it to `workspaces/<agent>/docs/<file>` and update every `{{system-doc:<file>}}` reference to `{{system-doc:docs/<file>}}`. A grep for the bare filename plus a `git mv` is the whole migration.
