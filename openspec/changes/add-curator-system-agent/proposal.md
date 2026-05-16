## Why

Builder modifies an agent's **code** — templates, identity files, routing, tool definitions. But a growing share of operator requests target an agent's **data**: "add Wendy to the Master Client Log," "Heather's hours changed to 9-5, update team.json," "rename the Staff label to Internal." Builder is the wrong tool for these:

- Builder's auto-merge gate is restricted to `templates/**/*.md`, `identity/*.md`, `README.md` — JSON/YAML data files don't qualify, so every data edit goes to human review even though most are trivial.
- Builder's gate is about prompt safety (template prose can't easily exploit anything). Data edits have a different threat model: schema validation, referential integrity, no PHI leaks into shared files.
- Builder's PR flow is high-ceremony for a one-line JSON edit.

The pattern is mature enough to deserve its own surface. **Curator** is the system agent for data — memory entries, JSON/YAML config files, sheet rows. She has her own gate (schema validation + invariant checks), her own auto-merge rules, and is dispatched through the same authenticated operator paths as Builder.

## What Changes

- Add **Curator**, a system agent in `src/system-agents/curator/`. Same clawndom-resident shape as Builder, dispatched through `POST /webhooks/system/curator`. Scope: data files under the dispatching agent's `path` (`team.json`, `gmail-labels.json`, `memory/**`, any `data/**` directory), never code (templates, routing, identity, tool defs).
- Add a `dispatch_to_curator` tool exposed only on privileged routes of opted-in agents.
- Auto-merge gate for Curator (kept in lockstep with a CI re-verification workflow same as PR #136):
  - Every changed line falls under the agent's `data/`, `memory/`, or a curated config-files allowlist (defined per-agent in `AGENTS_CONFIG` as `curatorAllowedPaths`).
  - The post-edit file passes a JSON Schema or Zod validation defined per-data-file (per-agent registry; e.g., `team.json` has a schema that requires `internal_domain` to be a valid domain, every staff member has an email, etc.).
  - No referential-integrity violations against the operator-visible namespace (e.g., deleting a therapist from `team.json` while they're still referenced in `clawndom.yaml` routing rules — Curator refuses and asks the operator if they want to ship the routing change too via Builder).
- Lifecycle mirrors Builder: `working`, `question_pending`, `testable`, `failed`. `testable` for data edits typically means "live" (config reload is much cheaper than agent restart — clawndom can rebind a JSON file in-process).
- Reuse Builder's draft-PR-as-state pattern. Curator opens a draft PR per dispatch; the PR body is the plan with the before/after diff of the data edit.
- The same vocabulary firewall as Builder/Diagnostician.

## Distinction from Builder

| | Builder | Curator |
|---|---|---|
| Scope | code: templates, identity, routing, tools | data: memory, team.json, gmail-labels.json, data/** |
| Auto-merge gate | path allowlist (templates/identity/readme) | schema validation + referential integrity |
| Going live | requires clawndom restart (deploy_webhook / cache_refresh / pr_preview) | typically hot-reloadable (config file re-read in-process) |
| When ambiguous | If a change requires both: Builder dispatches **and** Curator dispatches, with Curator's `question_pending` flagging the dependency. |

## Capabilities

- **curator-agent** — Curator's behavior contract.
- **curator-dispatch** — dispatch payload + lifecycle states + allowlist enforcement.
- **curator-data-validation** — per-data-file schema registry + validation contract.
- **curator-referential-integrity** — cross-file invariant checks (Curator refuses edits that orphan or duplicate identifiers).

## Out of scope

- Modifying code (templates, routing, tool defs). Those go to Builder.
- Bulk-import operations (e.g., importing 100 client records from a CSV). Initial scope is one-edit-per-dispatch — bulk import gets its own design conversation once the per-edit shape proves out.
- Cross-tenant edits. Curator is scoped to the dispatching agent's data, same as Builder.
- Sheet-level edits (Google Sheets MCL). Initial scope is files in the workspace repo only; sheet edits stay with operator/Heather for now.

## Deliverables

- OpenSpec change directory with proposal, capability specs, an implementation task list, and a `data-schema-registry/` design sketch describing how per-data-file validators are registered without polluting Curator's prompt.
