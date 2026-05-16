# Implementation tasks

Order: settle the per-tenant-repo vs single-repo question first; everything else depends on it.

## 0. Settle the open question

- [ ] In `design.md`, argue per-tenant-fork vs single-multi-tenant-repo. Decision sticks.
- [ ] Update Builder's auto-merge path allowlist (in `prompt.md`) to enforce the chosen shape: if single-repo, paths get a `tenants/<agent-name>/` prefix.

## 1. CLI scaffold

- [ ] `infra/control-plane/clawnctl/` — TypeScript CLI, single entry point, commands `new-practice`, `status`, `update`, `destroy`.
- [ ] Idempotency state lives in a JSON manifest per tenant in S3 (or DynamoDB) — the CLI reads to figure out where to resume.
- [ ] Unit tests for the manifest read/write + the command-dispatch routing.

## 2. AWS via CDK

- [ ] `infra/control-plane/cdk/` — CDK app templating one stack per tenant. EC2 + EBS + SG + IAM + CloudWatch.
- [ ] Bootstrap script (the same `bootstrap.sh` that's already in `infra/ec2/`) runs on EC2 first boot via CloudFormation user-data.
- [ ] Tenant-aware: stack name `clawndom-<slug>`, instance tag `clawndom-tenant=<slug>`.

## 3. GCP via Terraform

- [ ] `infra/control-plane/terraform/gcp/` — single module per tenant.
- [ ] Outputs the Pub/Sub topic name, push subscription URL, service-account email, OIDC audience — all the values the host's `clawndom.env` needs.
- [ ] CLI reads the Terraform outputs and writes them into the host's env via the bootstrap step.

## 4. Google Workspace mailbox provisioning

- [ ] Script using the Admin SDK to create the bot mailboxes (`winston@<domain>`) under the practice's existing Workspace customer.
- [ ] Same script grants the DWD scopes needed for Gmail watch + push + read + send.
- [ ] Pre-creates a starter set of Gmail labels using the operator-tunable slug list from `practice.config.example.json`.

## 5. 1Password integration

- [ ] CLI generates per-tenant secrets (GitHub App private key for Builder, signing secrets) and writes them to a per-tenant 1Password vault.
- [ ] CLI emits the secret references (vault + item-name) needed by `clawndom.env`.

## 6. Tailscale node registration

- [ ] CLI uses the Tailscale API to pre-authorize the EC2 node + tag it with `clawndom-tenant=<slug>`.
- [ ] ACL tags ensure only the practice's operator + the org's reviewer can SSH to the host.

## 7. Practice config bootstrap

- [ ] CLI prompts for (or accepts via flags) every field in `practice.config.json`.
- [ ] Writes the config into the tenant's workspace (per the shape settled in step 0).
- [ ] Commits + opens a PR with the new tenant onboarding.

## 8. Smoke test: provision a demo tenant

- [ ] Run `clawnctl new-practice demo --operator chris.creel@sc0red.com --domain demo.sc0red.com` end-to-end.
- [ ] Verify Winston-the-second-instance speaks in demo's voice via a Heather-equivalent email through the demo's Gmail.
- [ ] Tear down via `clawnctl destroy demo --confirm demo`.

## 9. Documentation

- [ ] `docs/guides/PROVISIONING.md` — operator-facing CLI reference.
- [ ] `docs/guides/MULTI_TENANT_ARCHITECTURE.md` — the boundary story for security review / future buyers.
