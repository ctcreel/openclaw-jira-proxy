## Why

Standing up Winston for a second practice today is a multi-day manual chore. The dependent surfaces touch a long list of things:

- A new GCP project (or shared project + new service account) for Pub/Sub topic + Gmail watch DWD impersonation.
- A new Google Workspace customer (theirs) with the practice's `winston@`, `<therapist>@`, etc. mailboxes.
- Gmail labels created in each mailbox with operator-meaningful slugs.
- A new EC2 instance sized appropriately, bootstrapped with clawndom + agency-tools + winston-agency clones.
- A new 1Password vault per tenant with their per-secret entries (OAuth client, Stripe API key, Xero credentials, Calendly PAT, GitHub App credentials for Builder).
- Tailscale node added to the org's tailnet with operator-only ACL.
- DNS for the Tailscale-Funnel HTTPS endpoint.
- The `practice.config.json` filled in for the tenant.
- Branch protection on the tenant's winston-agency fork (or a multi-tenant single-repo design — see "Open question" below).
- The first dispatch wiring (Gmail Pub/Sub push subscription pointing at the new EC2's `/hooks/gmail-pubsub`).
- BAAs signed (these the user already has lined up in advance).

Doing this by hand is hours and error-prone. To hit the $500/month target with reasonable margin, provisioning needs to be a CLI command that takes the new practice's name + operator email + a few secret references and walks through every step idempotently.

## What Changes

- Add a **control-plane CLI** (working title: `clawnctl`) under `infra/control-plane/`. Single binary, opinionated commands:
  - `clawnctl new-practice <slug> --operator <email> --domain <talkatlanta-equiv>` — runs the full provisioning sequence.
  - `clawnctl status <slug>` — health check of a tenant's deployment.
  - `clawnctl update <slug>` — push the latest clawndom + workspace to a tenant (paired with the self-update timer from PR #138).
  - `clawnctl destroy <slug> --confirm <slug>` — full teardown (requires double-confirm).
- The CLI is **declarative**: every step is idempotent. Running `new-practice` twice on the same slug picks up where it left off, never double-creates resources.
- **AWS resources via CDK** (TypeScript, matches the rest of the codebase). A single CDK app templates: EC2 instance, EBS volume, security group, IAM role, CloudWatch log group, Tailscale-Funnel-friendly outbound routing. Each tenant is a CDK stack named `clawndom-<slug>`.
- **GCP resources via Terraform** (the GCP CDK story is weaker). One module per tenant: Pub/Sub topic, push subscription, service account, IAM bindings. Outputs the OIDC config the operator pastes into the host's `clawndom.env`.
- **Google Workspace operations via the Admin SDK** with a control-plane service account. The CLI uses the operator's OAuth token to mint mailboxes + labels via the Workspace Admin API. (Most practices already have a Workspace; the CLI just creates the bot accounts under their domain.)
- **1Password operations via 1Password Connect** (or the regular CLI for one-off provisioning). The control plane generates secret materials (per-tenant GitHub App private keys, per-tenant signing secrets) and writes them into a per-tenant vault.
- **Tailscale via the Tailscale API**: register the EC2's node key, apply per-tenant ACL tags.
- The first provisioning run for a new practice produces a checklist of "manual steps you still must do": sign the BAA, hand the practice the operator URL, install Tailscale on the operator's laptop. Everything else is automated.

## Capabilities

- **practice-provisioning** — the `new-practice` flow, idempotent, declarative.
- **practice-status** — the health-check flow, surfacing per-tenant deployment state.
- **practice-update** — the update-deployment flow, coordinated with the self-update timer.
- **practice-destroy** — the teardown flow with the double-confirm safety.

## Open question (to settle in design.md)

**Per-tenant repo vs single-tenant-aware repo.** Today winston-agency is one repo. For multi-tenant, two viable shapes:

- **Per-tenant fork.** Every tenant gets `<tenant>-winston-agency`. CI runs separately. Risk: drift between tenants on operator-tunable surfaces.
- **Single multi-tenant repo with `tenants/<slug>/practice.config.json`.** One CI, one set of templates, every tenant's config lives side-by-side. Risk: a Builder PR opened by tenant A can in principle touch tenant B's config.

The single-repo design with strict path-allowlist on Builder (only `tenants/<slug>/` for an `agentName=<slug>` dispatch) is leaner and is the working assumption for this proposal, but design.md should explicitly argue for one over the other.

## Out of scope

- Billing automation. Stripe Connect for the $500/month is a separate effort.
- Customer-facing onboarding UI. The CLI is operator-only; customers don't run it.
- Automated BAA generation / signing.
- Custom Winston voice tuning per practice.

## Deliverables

- This OpenSpec change directory.
- Implementation tasks split into CLI scaffold, AWS CDK module, GCP Terraform module, Workspace Admin scripting, 1Password integration, Tailscale node registration, and a smoke-test that stands up a "demo" practice end-to-end.
