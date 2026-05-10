# Tool Manifest Frontmatter for Templates

> Status: Stable (SPE-2070)
> Audience: Agent template authors, anyone wiring up Python helpers

Templates can declare a YAML manifest of Python helpers in frontmatter. The
renderer expands it into a `{{tools}}` placeholder and ships the rendered
docs in the cacheable system slot, so tool documentation lives in the
prompt-cache prefix rather than the per-event body. The result: stable
bytes across runs, lower per-event cost, no copy-pasted heredoc usage
examples to drift over time.

## When to use this

You have a Python helper module under your agent's `agency-tools` clone
(e.g. `agency_tools.slack.post`) and you want the agent to know:

- That the helper exists
- Its public callables, signatures, and docstrings
- The canonical bash heredoc invocation pattern, including how to read its
  required env vars

If you'd otherwise hand-write that documentation in the template body
every time the helper's signature changes, this is the path.

## Anatomy

```markdown
---
tools:
  - module: agency_tools.slack.post
    requires_env: [slack_patch_bot]
  - module: agency_tools.jira.search
---

# Your normal template body

…instructions…

{{tools}}

…more instructions…
```

Three things:

1. **`tools:` array** — each entry has a `module` (importable dotted path)
   and an optional `requires_env` list of secret keys the helper needs at
   runtime.
2. **`{{tools}}` placeholder** — emitted into the system slot at this
   document position. Order matters: the rendered tool block lands at the
   document position of the placeholder, alongside any
   `{{system-doc:…}}` / `{{system-shared:…}}` tags.
3. **Body** — everything outside the frontmatter renders normally. Per-event
   Nunjucks variables, body-level `{{doc:…}}` and `{{shared:…}}` tags all
   keep working as before.

## What gets rendered

For each declared module, the renderer invokes a short-lived Python
introspector (`tools-introspect.py`) under `PYTHONPATH=<agency-tools clone>`
and emits a Markdown block:

```markdown
## agency_tools.slack.post

<module-level docstring>

### `post(*, bot_token: str, channel: str, text: str) -> dict`

<callable docstring>

```bash
bash <<'PY'
import os
from agency_tools.slack.post import post
# Provide slack_patch_bot via the matching SECRETS_CONFIG entry.
post(bot_token=os.environ['SLACK_PATCH_BOT'])
PY
```
```

A few details worth knowing:

- **Public-only callables.** `inspect.isfunction` filters; underscore-prefixed
  names are skipped; re-imports (`from .errors import SlackAPIError`) don't
  show up on the importing module.
- **Alphabetical order.** Stable across runs — prompt-cache stays warm.
- **`requires_env` shape.** Single env keys render the
  `bot_token=os.environ['…']` keyword form, matching the existing helper
  idiom. Multi-env helpers render an explicit reminder; rare today, edit
  the call template-side if you need a more specific shape.

## Secrets

Every `requires_env` entry must be a key registered in `SECRETS_CONFIG`.
The validator runs at boot and lists every offender in one error — so a
typo (`slack-patch-bot` vs `slack_patch_bot`) fails the deploy rather than
silently rendering a docs block that points at a non-existent secret. The
runner already injects matching env vars into Python subprocesses via
the existing `provider.envSecrets` machinery.

## Cache reuse

`renderToolBlock` keys its in-process cache on
`(frontmatterContentHash, agencyToolsPath)`:

- **Frontmatter content hash** captures *which tools, in what order, with
  what env*. Two templates with byte-identical frontmatter share a
  rendered block — they hit the same cache entry.
- **Agency-tools path** captures *which clone the introspector saw*. Same
  config, two different worktrees of agency-tools = two cache entries.

The cache is per-process. Editing helper docstrings in-place during a
running clawndom does not rerender; restart to pick up the change. Same
constraint that already applies to every other piece of agent config.

## Boot validation

`validateToolTemplates` runs in `startServer` after `loadAgents` and
asserts:

1. **Placeholder ↔ declarations** — `{{tools}}` without `tools:` (or vice
   versa) is a misconfig. Both directions fail at boot.
2. **Secrets resolve** — every `requires_env` entry must be a known
   `SecretManager` key.
3. **Modules import cleanly** — the introspector loads each declared
   module under the agent's `agency-tools` clone path. ImportError surfaces
   the dotted path so you know exactly which entry to fix.

Failures aggregate. One thrown error lists every offender so a
misconfigured deploy doesn't burn through a "fix one, learn the next"
loop.

## Fail modes worth knowing

- **Agent has no `sharedTools` configured.** Declaring `tools:` without a
  matching `sharedTools` entry in `AGENTS_CONFIG` fails at boot — the
  validator can't resolve a `PYTHONPATH` to introspect against. Add the
  `sharedTools` entry.
- **`python3` not on PATH.** The renderer throws a named error at runtime
  (and at boot if the validator runs). Install Python 3 or remove
  `tools:` declarations from every template.
- **Frontmatter unknown key.** The schema is `.strict()` — `tool:`
  (singular typo), `requires-env` (kebab vs snake), or any field the
  schema doesn't know about throws at parse time. Fix the typo.

## Migration checklist

Adding a manifest to an existing template:

1. Add the `---` frontmatter fence + `tools:` array at the top of the
   template.
2. Insert `{{tools}}` at the document position you want the rendered
   block.
3. Confirm the agent's `AGENTS_CONFIG` entry has a `sharedTools` block
   pointing at the agency-tools clone path.
4. Confirm every `requires_env` entry is in `SECRETS_CONFIG`.
5. Restart clawndom. Boot validation tells you if anything's missing.

## Related

- `src/lib/template/frontmatter.ts` — schema + parser
- `src/lib/template/render-tool-block.ts` — Markdown renderer + cache
- `src/lib/template/tools-introspect.py` — Python subprocess
- `src/lib/template/validate-tool-templates.ts` — boot validation walker
