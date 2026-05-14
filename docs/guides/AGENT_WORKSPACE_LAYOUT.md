# Agent workspace layout

Canonical directory shape for an agent workspace consumed by Clawndom. New agents start from this skeleton; existing agents are expected to match it.

**Skip the manual setup** — use the [`SC0RED/agent-workspace-template`](https://github.com/SC0RED/agent-workspace-template) template repo (`gh repo create my-agent --template SC0RED/agent-workspace-template`). It ships the skeleton below plus a working audit workflow. For a new agency-tools package, the equivalent is [`SC0RED/agency-tool-template`](https://github.com/SC0RED/agency-tool-template). **Heads-up:** GitHub template repos don't propagate updates — when you create from a template, you get a snapshot. Audit rules (which live in clawndom and are pulled live by the workflow) update automatically; the static skeleton (file structure, README scaffolding) does not.

## Required skeleton

```
workspaces/<agent>/
  clawndom.yaml          ← routing rules + per-route tools + memory namespaces
  identity/              ← agent identity (single-purpose tier)
    IDENTITY.md          ← who the agent is, who they work with
    SOUL.md              ← voice, principles, do/don't
    <auth-identity>.md   ← service-account identity docs (e.g. jira-as-patches.md)
  shared/                ← cross-template reusable docs + structured data
    <reference>.md       ← per-agent reference material the templates inject
    <data>.json          ← structured data (rosters, label maps)
  templates/             ← Nunjucks templates dispatched by routing rules
    *.md
```

Three directories with clear purposes:

- **`identity/`** — who the agent is. Stable across runs. Injected into nearly every template.
- **`shared/`** — what the agent's templates have in common. Reference content, data files. Templates pick what they inject.
- **`templates/`** — the per-route Nunjucks templates Clawndom dispatches.

Every file referenced by a template via `{{system-doc:...}}` or `{{doc:...}}` lives in `identity/` or `shared/`. The injection path is always `<dir>/<file>`, never a bare filename at the workspace root.

### Why two subdirectories instead of one `docs/`

A flat `docs/` lumps two different kinds of content together. Identity (`IDENTITY.md`, `SOUL.md`, service-account auth) is single-purpose and almost-always-injected. Reference content (TOOLS inventory, label maps, team data) is plural and varies by template. Splitting them makes the intent visible in the file layout and keeps a "I forgot to inject identity" scan trivial: every template should `{{system-doc:identity/...}}` at the top, full stop.

`clawndom-audit` enforces the "no bare filenames at the workspace root" rule (`injection-at-workspace-root`). It doesn't require the exact names `identity/` and `shared/` — any subdirectory satisfies the path-shape rule — but those are the canonical names and what the README, layout doc, and Clawndom examples use. Don't invent a new name without a reason.

## Required files

| File | Purpose |
|---|---|
| `clawndom.yaml` | Routing rules: schedule (cron), webhook (per-provider rules with conditions), internal (`taskType → template`), plus `modelRules` and per-route `tools:` declarations. Memory namespaces declared at the top. |
| `identity/IDENTITY.md` | Who the agent is: name, role, who they work with, what mailboxes/channels they touch. Injected into every template via `{{system-doc:identity/IDENTITY.md}}`. |
| `identity/SOUL.md` | Engineering / voice / interaction principles. Sets behavior, not capability. |

## Optional layout variants

### Variant A — single-agent repo (e.g., winston-agency)

```
winston-agency/
  README.md
  workspaces/winston/
    clawndom.yaml
    identity/
    shared/
    templates/
```

No `workspaces/shared/` at the workspace level — no peer agents to share with. The agent's shared library (typed Python tools) lives in a separate repo (e.g., `agency-tools`), pulled by Clawndom at boot via `AGENTS_CONFIG.sharedTools.{repo, ref, path}`. The clone lands next to the agent at runtime so templates can reference shared tool modules in route declarations (`tools: - module.python: agency_tools.google.gmail_send`).

Use this variant when:

- The repo houses a single agent (or agents that don't share prose docs).
- The shared library is a separately-versioned package (Python, npm, etc.) with its own release cadence.
- The agent's host has any compliance / isolation constraint (HIPAA, separate AWS account) that argues for a separately-deployed repo.

### Variant B — multi-agent repo (e.g., the-agency)

```
the-agency/
  README.md
  workspaces/
    shared/                              ← cross-agent reference material
      sc0red-engineering-pipeline.md
      anti-patterns.md
      writing-great-*.md
      TOOLS.md
      ...
    scripts/                             ← operator scripts (token generators, dumps)
      generate-jira-<agent>-token.sh
      ...
    <agent-a>/
      clawndom.yaml
      identity/
      templates/
    <agent-b>/
      clawndom.yaml
      identity/
      templates/
```

`workspaces/shared/` is injected via the `{{system-shared:<file>}}` / `{{shared:<file>}}` prefixes (vs `{{system-doc:<file>}}` / `{{doc:<file>}}` for per-agent files). Files sit directly under `shared/` — no nested `docs/` subdir.

`workspaces/scripts/` holds operator scripts (token-fetch helpers, workflow dumpers). Templates shell out to them via `bash ../../scripts/<name>.sh`. The name `scripts/` (not `tools/`) is deliberate — `tools` collides with the SPE-2078 sense (`module.python:` declarations on a route).

Use this variant when:

- Two or more agents in the repo share substantial prose (engineering pipeline, writing guides, auth patterns).
- The shared content is tightly coupled to its consumers and versioning it separately would create coordination overhead.

In this variant, **each agent still has its own `shared/`** for per-agent cross-template content. Workspace-level `shared/` is for content shared across agents.

## Cross-cutting expectations

Regardless of variant:

- **No `CLAUDE.md` per agent.** The Claude CLI auto-loads any `CLAUDE.md` in the cwd into the system prompt, which would inject content Clawndom didn't explicitly choose on every hook session. Use the template + injection mechanism instead so Clawndom owns the prompt byte-for-byte.
- **Avoid literal `{{` inside injected docs.** Nunjucks renders the system slot too; a literal `{{` inside an injected doc gets parsed as a template tag and the render fails. Describe template syntax in prose rather than showing literal examples. (`clawndom-audit` catches this — see the `literal-mustache-in-doc` and `injection-token-in-injected-doc` rules.)
- **Per-route `tools:` declarations** in `clawndom.yaml` are the authoritative list of what the agent can call on a given route. Templates emit `tool_use` blocks against those tools; Clawndom registers them with the Anthropic tool-use API at job start. If a template references a tool not declared on its route, `clawndom-audit` flags it (`undeclared-tool`).

## What does NOT belong in the workspace

- Compiled artifacts, Python `__pycache__`, build output. The workspace is source-of-truth, not a build target.
- Per-host config (port numbers, file paths, secrets references). That lives in Clawndom's `clawndom.env` on each host.
- One-off scripts that ran once. Operator scripts that templates invoke at runtime belong in `workspaces/scripts/` (Variant B) or in the external shared library (Variant A).

## Validating a workspace

```
clawndom-audit <agent-workspace-path> [--shared-dir <path>]
```

Checks structural integrity against the rules above: missing templates, unresolved injections, bare-filename injections at the workspace root, tool-use references that aren't declared on the route, literal mustache tokens, legacy patterns. Zero findings is the bar.

## Migration from non-canonical layouts

If you find a file at `workspaces/<agent>/<file>` that templates inject via `{{system-doc:<file>}}`, move it into `identity/` (if it's identity-tier) or `shared/` (if it's reference data). Update every `{{system-doc:<file>}}` reference to `{{system-doc:identity/<file>}}` or `{{system-doc:shared/<file>}}`. A grep for the bare filename plus a `git mv` plus a `perl -i -pe 's|...|...|g'` is the whole migration. Then run `clawndom-audit` to confirm zero findings before push.
