# Implementation tasks

Order: schema registry + bot identity land first; routes + tool registration last. The schema registry is the structural defense — without it, Curator would mutate JSON freely.

## 1. Credentials and identity

- [ ] Create the GitHub App `sc0red-curator[bot]` with write permissions scoped to the data-file paths only (or repo-write where the bot allowlist + branch protection already constrains scope). The Curator bot identity replaces Builder's only for Curator-authored PRs.
- [ ] Register the 1Password item `"GitHub App: sc0red-curator"` in `Engineering`.
- [ ] Confirm the bot is in the per-workspace-repo bot-allowlist alongside Builder.

## 2. Schema registry

- [ ] Design the per-data-file schema registry. Each workspace declares, in its `clawndom.yaml` or a sidecar `data-schema.yaml`, a map from data-file path → Zod schema name. Curator looks up the schema by path before editing.
- [ ] Implement the registry as `src/system-agents/curator/data-schema-registry.ts` with built-in validators for `team.json` and `gmail-labels.json` (the two files Winston has today).
- [ ] Implement referential-integrity checks: when Curator edits `team.json` to remove a therapist, run a cross-file check against the workspace's `clawndom.yaml` routing rules. If the removed value is referenced, emit `question_pending` asking the operator to confirm + dispatch the routing change to Builder.

## 3. Agent definition

- [ ] Add `curator/` under `src/system-agents/` with the same shape as `builder/`:
  - `prompt.md` — auto-merge gate definition, schema-validation rules, referential-integrity rules, vocabulary firewall.
  - `agent-config.ts` — `curatorBotRef`, `curatorAllowedPaths`, `curatorTestableMechanism`.
  - `payloads.ts` — dispatch + callback schemas.
  - `templates/dispatch.njk` — prompt body.
  - `plan-template.md` — PR-body template (analog of Builder's, adapted to data edits).

## 4. Routes

- [ ] Add `POST /webhooks/system/curator` route + controller (internal-bearer gated).
- [ ] Add `POST /webhooks/curator-callback` route + controller (internal-bearer gated).
- [ ] Wire both in `src/routes/index.ts`.

## 5. Queues and runner

- [ ] Add `curator-dispatch` and `curator-callback` BullMQ providers.
- [ ] Add the `curator` system-agent loader.

## 6. Tool: dispatch_to_curator

- [ ] Add `dispatch_to_curator` to `agency-tools` with the same privileged-route-only attachment as `dispatch_to_builder`.
- [ ] Update Winston's `email-chat.md` to classify "add X to MCL," "update team.json field Y," "change label name Z" as Curator dispatches rather than Builder.

## 7. CI re-verification

- [ ] Add a `.github/workflows/curator-auto-merge-gate.yml` reusable workflow analogous to `builder-auto-merge-gate.yml`. The classifier:
  - Asserts every modified path is in `curatorAllowedPaths`.
  - Re-runs the schema validation server-side as a sanity check.
- [ ] Workspace repos opt in by adding the caller workflow.

## 8. Tests

- [ ] Schema registry tests (per-file validators round-trip).
- [ ] Referential-integrity tests (removal triggers cross-file scan).
- [ ] Dispatch + callback integration tests.
- [ ] Auto-merge gate path-allowlist tests.

## 9. Documentation

- [ ] Add a "Data vs code: when to dispatch to which system agent" section in `docs/guides/SYSTEM_AGENTS.md`.
- [ ] Add an entry in winston-agency's IDENTITY explaining how Winston decides between Builder and Curator for ambiguous requests.
