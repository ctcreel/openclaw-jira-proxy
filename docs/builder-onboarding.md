# Onboarding an agent to Builder

Builder is a clawndom-bundled system agent that performs add / change / delete work on the **dispatching agent's directory** in its repo. This recipe is run **once per agent-repo** by an operator (you), optionally automated by an outside agent like Patch. **Builder cannot bootstrap her own access** — chicken-and-egg: she would need write access to configure the rule that grants her write access.

The recipe is structured in two layers:

- **Per agent-repo** — once per repo regardless of how many agents inside it opt in. Provisioning a GitHub App, storing credentials, configuring branch protection.
- **Per agent** — once per agent inside the repo that should accept dispatch-to-Builder requests. Declaring the per-agent config (allowlist, testable mechanism, branch convention) and adding the privileged-route template variant + tool grant.

## Prerequisites

- Operator access to the agent-repo on GitHub
- 1Password access to the `Engineering` vault
- Operator access to the clawndom deploy environment (to update `SECRETS_CONFIG` / `AGENTS_CONFIG`)
- The supervisor (PM2 / systemd / k8s deployment) used to bounce clawndom — its webhook-firing capability or scriptable post-restart hook
- The shared `BUILDER_INTERNAL_BEARER` secret already in 1Password and bound in clawndom's `SECRETS_CONFIG`

## Layer 1 — Per agent-repo

### 1.1 Provision a dedicated GitHub App for Builder against the agent-repo

Create a new GitHub App with permissions:

- `Contents: Read & Write`
- `Pull requests: Read & Write`
- `Metadata: Read`

Naming convention: `<repo>-builder` (e.g., `the-agency-builder`).

Install the App on the agent-repo only. Do not install it on other repos.

### 1.2 Store the App credentials in 1Password

Add an item under the `Engineering` vault:

- Item name: `GitHub App: <repo>-builder`
- Fields: `app_id`, `private_key`, `installation_id`

Add a binding in clawndom's `SECRETS_CONFIG`:

```json
{
  "key": "builder_bot_<repo_slug>",
  "provider": "onepassword",
  "reference": "op://Engineering/GitHub App: <repo>-builder/private_key"
}
```

The logical key `builder_bot_<repo_slug>` is what each opting-in agent in this repo references via its `builderBotRef` field (Layer 2).

### 1.3 Update branch protection on `main`

In the repo's GitHub settings, edit branch protection for `main`:

- Require pull request reviews before merging (standard)
- Require status checks to pass before merging (standard)
- **Restrict who can author PRs to an approved-bot allowlist** that includes:
  - The new `<repo>-builder[bot]` identity
  - Every other bot that legitimately authors PRs against this repo (e.g., `patch[bot]`, `scarlett[bot]`)
  - Your own GitHub account if you ever open PRs manually

This is an **allowlist, not an exclusion rule**. Adding Builder MUST NOT remove existing legitimate bots — they continue to operate as before.

### 1.4 Configure the supervisor's post-restart hook

After each clawndom restart that includes a merged Builder PR, the supervisor MUST POST to:

```http
POST https://<clawndom>/webhooks/builder-deploy-complete
Authorization: Bearer <BUILDER_INTERNAL_BEARER>
Content-Type: application/json

{ "jobId": "<job_id>", "status": "ok" }
```

(Or `"status": "failed"` with an optional `reason` if the new instance fails to come up healthy.)

The supervisor needs to know which `jobId` to send. Convention: read it from the most-recently-merged Builder PR's commit trailer (`Builder-Job-Id: <id>`) which Builder writes into her commits. The supervisor's hook script MUST locate the most recent commit *authored by the Builder bot* (otherwise a non-Builder merge could be picked up, sending the wrong `jobId`) and only then read the trailer. Example:

```sh
BUILDER_BOT="<repo>-builder[bot]"
COMMIT=$(git log -n 1 --author="$BUILDER_BOT" --format='%H')
JOB_ID=$(git show -s --format='%(trailers:key=Builder-Job-Id,valueonly=true)' "$COMMIT")
if [ -z "$JOB_ID" ]; then
  echo "No Builder-Job-Id trailer on $COMMIT; refusing to fire deploy-complete" >&2
  exit 0
fi
```

If `JOB_ID` is empty, fail closed — do **not** POST to the deploy-complete webhook with an empty or guessed value.

## Layer 2 — Per agent

Repeat these steps for each ordinary agent inside the agent-repo that should be able to dispatch Builder requests.

### 2.1 Declare the per-agent fields in `AGENTS_CONFIG`

Add the Builder fields to the agent's existing entry. Example (for an agent named `winston` living in `the-agency`):

```json
{
  "name": "winston",
  "repo": "git@github.com:org/the-agency.git",
  "path": "agents/winston",
  "ref": "main",
  "builderBotRef": "builder_bot_the_agency",
  "branchNamingPattern": "builder/{summary}",
  "operatorAllowlist": [],
  "testableMechanism": {
    "type": "deploy_webhook",
    "webhookUrl": "https://<clawndom>/webhooks/builder-deploy-complete"
  }
}
```

Notes:

- `operatorAllowlist` starts **empty** — no operator can dispatch until you explicitly add their email. This is the safe default.
- `branchNamingPattern` is optional; omit to use `builder/<kebab-summary>`.
- `testableMechanism` for clawndom-resident agents in v1 is `deploy_webhook`; the supervisor's hook is what actually fires it.

### 2.2 Add the `dispatch_to_builder` tool definition to the agent's tool registry

This is agent-runtime-specific (lives in the agent's repo, not in clawndom). The tool MUST:

- POST to `https://<clawndom>/webhooks/system/builder`
- Send `Authorization: Bearer <BUILDER_INTERNAL_BEARER>` (the agent's runtime reads it from the same logical secret)
- Construct the payload per the `BuilderDispatchPayload` Zod schema (see `src/system-agents/builder/payloads.ts`)
- Include the `replyContext` envelope so subsequent callbacks can route back to the original Slack/email thread

### 2.3 Add the privileged-route template variant

The agent's runtime serves multiple routes (one per channel/audience). Only the **privileged route** — the one operators use, not civilians — should load `dispatch_to_builder`. Add a template variant for that route that:

- Re-checks sender identity against `operatorAllowlist` (Layer 2 of the security model — tool presence is Layer 1, Builder re-verifies on receipt is Layer 3)
- Refuses with a clear message if the sender is not on the allowlist
- Provides usage guidance: when to call `dispatch_to_builder`, what to put in `request`, how to construct the `replyContext` envelope
- Includes operator-facing rendering for each Builder callback state (`working`, `question_pending`, `testable`, `failed`)

### 2.4 Update the agent's tool-grant config

Ensure `dispatch_to_builder` is loaded into the agent's tool list **only on the privileged route**. On every other route, the tool MUST NOT appear in the tool list. This is the structural defense — prompt injection in a civilian channel cannot call a tool that isn't loaded.

### 2.5 Add the agent's callback handling routing rule

In the agent's `clawndom.yaml`, add a routing rule under `routing.builder-callback.rules` that matches callbacks targeting this agent (by `agent_name` in the payload) and renders the appropriate operator reply.

### 2.6 Smoke-test before widening access

With the allowlist still empty:

1. As an operator NOT on the allowlist, dispatch a test request. Confirm it is refused at every layer.
2. Add one test operator email to the allowlist.
3. Dispatch a no-op improvement (e.g., "add a comment to the agent's README"). Confirm Builder produces a PR authored by `<repo>-builder[bot]`.
4. Confirm `make check-all` (or the workspace's configured equivalent) passes inside the PR.
5. Confirm the supervisor restarts clawndom and posts to `/webhooks/builder-deploy-complete`. Confirm the `testable` callback reaches the agent and the operator sees a reply.
6. Test `question_pending` by configuring Builder to deliberately ask a question; confirm the operator's answer resumes Builder via a follow-up dispatch.
7. Test `failed` with an out-of-scope request (e.g., one requiring clawndom modification). Confirm Builder refuses cleanly.
8. Widen the allowlist to the agent's full operator set.

### Rollback per agent

Empty the `operatorAllowlist` for that agent and redeploy. Dispatches from that agent immediately stop succeeding (refused at Layers 2 and 3) without affecting other agents.

### Global rollback

Disable Builder's queue worker (remove or rename `builder-dispatch` from the providers list in `PROVIDERS_CONFIG`). All in-flight Builder jobs drain through BullMQ; no data migration to reverse.

## What Builder cannot do

She doesn't bootstrap her own GitHub App. She doesn't configure branch protection. She doesn't add herself to the bot allowlist. All of these are operator responsibilities — you (or Patch on your behalf, from outside the runtime) run them once per agent-repo. Builder runs only when dispatched on her dedicated webhook route by an opted-in agent.
