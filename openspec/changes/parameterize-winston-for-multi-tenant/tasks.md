# Implementation tasks

Order: schema + audit land first; template conversion follows piece-by-piece behind the audit rules.

## 1. Inventory the TALK-isms

- [ ] Run a grep audit: `talkatlanta\.info|TALK Speech|Heather Hamilton|770\.302\.6902|690 Miami Circle|7703026902|SLP007896` across `workspaces/winston/`. Record every hit in `openspec/changes/parameterize-winston-for-multi-tenant/inventory.md` so the conversion has a complete checklist.
- [ ] Identify the smaller set of "operator-tunable" values that should live in the editor UI (gmail labels, school domains) vs the "one-time at provisioning" values (practice name, address). The split affects which surfaces operators can edit live.

## 2. Schema

- [ ] Define `practice.config.json` Zod schema in `src/services/practice-config.service.ts`. Cover every field listed in the proposal.
- [ ] Add a loader: reads `<workspace>/practice.config.json`, validates, returns typed config. Fails the boot if the file is missing or invalid.
- [ ] Write a `practice.config.example.json` in winston-agency with placeholders so a new practice provisioning has a starter file.

## 3. Template expansion layer

- [ ] Extend the workspace template renderer to inject `practice` as a top-level variable available in every template. Today templates already receive payload + context; this adds a third top-level.
- [ ] Add unit tests: render a fixture template with `{{ practice.staff.primary.name }}` → expected expanded value.
- [ ] Document the new variable in `docs/guides/TEMPLATE_VARIABLES.md`.

## 4. Routing slug expansion

- [ ] At agent-loader time, walk the parsed `clawndom.yaml` and expand `${staff.primary.email}` / `${staff.therapists[].email}` / `${domain.internal_domain}` against `practice.config.json`. The expansion happens BEFORE the loader hands the parsed config to the worker, so the worker sees fully-expanded values.
- [ ] Workspace-audit rule: routing rules MUST use slug form, not literal email addresses (except for allowlisted external addresses like Stripe/Calendly).
- [ ] Tests: round-trip a YAML with slugs → expand → compare to a literal-expanded YAML.

## 5. Convert one template at a time

The riskiest part. Order from least-to-most coupled:

- [ ] `evening-audit.md` — minimal cross-references, safe starter.
- [ ] `morning-briefing.md` — references staff names + phone + zoom.
- [ ] `inbox-triage.md` — references staff emails, school domains, partner vendors.
- [ ] `email-chat.md` — Tier 1/2 allowlist references.
- [ ] `draft-responses.md` — signature blocks, internal_domain references.
- [ ] `relay-builder-callback.md` — reviewer name + email.
- [ ] All other templates.

Each conversion is its own commit so a regression is easy to bisect.

## 6. Convert identity files

- [ ] Rename `identity/IDENTITY.md` → `identity/IDENTITY.md.njk`, `identity/SOUL.md` → `identity/SOUL.md.njk`.
- [ ] Add a render step to winston-agency's CI: run the templates against `practice.config.json` to produce `identity/IDENTITY.md` and `identity/SOUL.md` as build artifacts committed to the branch.
- [ ] Update the workspace audit to assert: if `.njk` source exists, the rendered `.md` is the build artifact and matches what fresh rendering produces (so PRs that edit only the rendered file fail).

## 7. Generate team.json

- [ ] Move `shared/team.json` to a generated artifact. The source of truth is `practice.config.json`.
- [ ] Add a build step to render `team.json` from the practice config on every PR.

## 8. Deny-list audit

- [ ] Workspace-audit rule: no template, routing rule, or identity file contains a literal value from the deny list (every concrete TALK-ism: phone, address, license, internal_domain literal, staff email literal). The deny list is generated from `practice.config.example.json` so a real config doesn't trigger the rule against itself.

## 9. End-to-end verification on Winston

- [ ] Run Heather through the full Heather→Winston→Builder cycle on the converted workspace; verify no operator-visible change.
- [ ] Run the inbox-triage cycle; verify every label / sender classification still works.

## 10. Stand up a second tenant

- [ ] Pick a placeholder second practice (e.g., "Demo Speech & Language") with synthetic data.
- [ ] Provision the EC2 instance per the sibling change `provision-new-practice-onboarding`.
- [ ] Deploy the same workspace with the demo's `practice.config.json`; confirm Winston-the-second-instance speaks in the demo's voice, references the demo's address, etc.
