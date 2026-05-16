## Why

Winston is the proof-of-concept for a "speech-therapy office manager" product. He works for TALK (Heather's practice), but the goal is to sell the same Winston shape to other speech-therapy practices: $500/month each, per-tenant EC2 instance, BAAs in hand.

The blocker today: TALK-specific values are hard-coded across Winston's workspace — staff names ("Heather Hamilton, M.S., CCC-SLP," "Piper Lashley"), practice name ("TALK Speech & Language Therapy, LLC"), phone numbers, addresses, the Zoom link, the GA SLP license number, internal_domain (`talkatlanta.info`), specific Gmail labels, calendar IDs, sheet IDs, the Pub/Sub topic, and so on. They live in:

- `identity/IDENTITY.md` and `identity/SOUL.md`
- Every template's signature block
- `shared/team.json`
- `shared/gmail-labels.json`
- `clawndom.yaml`'s routing conditions matching on staff email addresses
- A handful of inline rules (the "Known school domains" list, "Known staff" addresses, etc.)

Shipping a second practice today would mean a fork of winston-agency with all these values changed by hand. That's not a product; it's a bespoke install. The refactor here extracts every TALK-ism into a typed, per-tenant config so the workspace template is identical across practices and only the config differs.

## What Changes

- **Define a `practice.config.json`** at the workspace root. Single source of truth for tenant-specific values:
  - `practice` — name, legal entity, license, BAA-required flag.
  - `addresses` — physical address, mailing address.
  - `phones` — main, fax.
  - `zoom` — meeting link, password.
  - `domain` — internal_domain, public website.
  - `staff` — ordered list of `{name, email, role, signature, calendarId}`, with one entry marked `primary` (the operator who gets triaged inbox).
  - `practiceManager` — single entry equivalent to the current `practice_manager` in `team.json`.
  - `externalReviewer` — engineer-side identity for Builder review (`chris@sc0red.com`).
  - `extraTrustedSenders` — pre-existing personal addresses that should be Tier-1 trusted (today's `ctcreel.business@gmail.com`, etc.).
  - `gmailLabels` — operator-tunable labels with stable slugs (`staff`, `parent`, `prospect`, etc.); the per-mailbox numeric IDs stay in the legacy `gmail-labels.json` keyed by slug.
  - `knownSchoolDomains`, `knownPartnerVendors` — operator-tunable lists, today inline in inbox-triage.
  - `gcp` — pubsub topic, service-account ref.
- **Template engine pass on every template** to replace literals with `{{ practice.* }}` references. The new template input layer accepts `practice` as a top-level variable and renders it everywhere — signatures, identity prose, routing-rule conditions. Comment-preserving edits via `eemeli/yaml` (already used by editor-UI write flow PR #131) extend to template-level substitution.
- **Routing-rule rewrite**. Today's `clawndom.yaml` references staff emails by literal address:
  ```yaml
  - equals: { field: emailAddress, value: heather@talkatlanta.info }
  ```
  After the refactor, routing rules reference logical slugs that resolve from `practice.config.json`:
  ```yaml
  - equals: { field: emailAddress, value: ${staff.primary.email} }
  - equals: { field: emailAddress, value: ${staff.therapists[].email} }
  ```
  The agent-loader expands `${...}` against the loaded practice config before passing the parsed config to the worker.
- **Workspace audit** grows new rules: every template references `{{ practice.* }}` at least once for signatures; no template contains a literal `talkatlanta.info` (or any other tenant-specific string from a deny-list); every routing rule referencing a staff email uses the slug form.
- **`team.json` is reduced** to a derived view of `practice.config.json` (it stays for compatibility with templates that read it via `{{system-doc:shared/team.json}}`, but it's generated, not authored).
- **identity/IDENTITY.md and identity/SOUL.md** become `.njk` templates that get rendered into their .md form by a build step in the workspace's CI. The runtime reads the rendered .md, so no template-engine cost at agent dispatch.

## Capabilities

- **practice-config** — schema for `practice.config.json`, validation, defaults, BAA-required flag semantics.
- **template-variable-expansion** — the rendering layer that resolves `{{ practice.* }}` across templates + identity files + routing.
- **routing-slug-expansion** — `${staff.primary.email}` and similar expansions in routing conditions, evaluated at agent-loader time.
- **multi-tenant-audit** — workspace-audit rules that fail when a literal TALK-ism is present.

## Out of scope

- Provisioning the per-tenant EC2 instance, secrets, Gmail watch, GCP project — that's the sibling change `provision-new-practice-onboarding`.
- White-label branding beyond text substitution (custom Winston voice tuning per practice, branded email signatures with images). Initial scope is text-only.
- Multi-language. English-only.

## Deliverables

- This OpenSpec change directory.
- Implementation tasks split into:
  - Inventory the TALK-isms (grep + audit).
  - Define and ship `practice.config.json` schema.
  - Build the template-expansion layer (clawndom-side, in the workspace loader).
  - Convert templates one-at-a-time with audit rule blocking regressions.
  - Convert routing rules to slug form.
  - Generate `team.json` from the practice config.
  - Convert identity files to .njk + add build step.
  - Add the deny-list audit rules.
