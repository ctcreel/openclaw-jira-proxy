## Why

When an agent inside the clawndom runtime receives a request that requires modifying that agent's own definition — adding, changing, or deleting routes, tools, templates, memory specs, runner configs — the agent has neither the pattern-discipline nor the authorization boundary to do so safely. Winston recently embedded bash scripts into templates instead of defining proper tools, because nothing in his role told him not to. Once civilians reach an agent through email or Slack, any path from that agent to self-modification becomes a prompt-injection vector — so the platform needs a dedicated agent that other agents can ask to make those changes, one that lives behind authenticated operator gates, enforces the platform's conventions, and is reachable only through paths civilians don't have.

This proposal introduces a new category — **system agents**, centrally defined in clawndom and dispatched through authenticated operator paths only — and the first instance, **Builder**, which performs add / change / delete work scoped to the **dispatching agent's directory** within its repo. Outside agents the user wields against repos from outside the runtime (e.g., Patch, Scarlett for general software-development work) are unrelated to this change and out of scope.

## What Changes

- Introduce **system agents** as a category distinct from ordinary agents. A system agent's definition lives in `clawndom/src/system-agents/<name>/` (one consistent implementation), is reachable only through privileged operator-authenticated routes, and operates against the dispatching agent's directory using credentials tied to that agent's repo. Existing agents are unchanged; opt-in is per-agent (with provisioning shared per agent-repo since colocated agents share a repo). The path is deliberately distinct from clawndom's external-agent loading paths to avoid name collision with `AGENTS_CONFIG`-loaded agents.
- Add **Builder**, the first system agent. Builder's scope is **the dispatching agent's directory only**: add / change / delete templates, tools, memory specs, runner configs that live under the dispatching agent's `path` in its repo. She does not modify other colocated agents' directories, does not touch `sharedTools` directories (pinned by ref; require a separate coordinated change with a version bump), and never modifies clawndom itself.
- Add a privileged dispatch route (`POST /webhooks/system/builder`) authenticated by a new internal-bearer signature strategy, with a dedicated BullMQ queue and Builder runner registration. The dispatch payload carries `agent_name`, which Builder's runner resolves against `AGENTS_CONFIG` to find the target repo, path, Builder bot identity for that repo, branch convention, operator allowlist, and `testable_mechanism`.
- Add a callback route (`POST /webhooks/builder-callback`) for Builder to report lifecycle state transitions (`working`, `question_pending`, `testable`, `failed`) back to the dispatching agent. Callbacks are idempotent via `event_id`.
- Add a `dispatch_to_builder` tool, exposed only on **privileged routes** of an opting-in agent — never on civilian-facing routes. Tool presence is the structural defense.
- Add a privileged-route template variant for the operator-facing agent (currently Winston) encoding the operator-allowlist rule and `dispatch_to_builder` usage guidance.
- Adopt the **external-orchestrator restart strategy** (option 1) for v1: clawndom has no hot reload today, so a Builder change becomes live only after a clawndom restart. The existing supervisor (PM2 / systemd / k8s deployment) restarts clawndom after Builder's PR is merged, then fires a deploy webhook into clawndom; Builder's callback handler emits `testable` on receipt. The `testable_mechanism` config defaults to `deploy_webhook` for clawndom-resident agents; `cache_refresh` and `pr_preview` variants remain in the spec for future hot-reload and external preview environments.
- Branch protection on each opted-in agent-repo's `main` requires the PR author to be in an **approved-bot allowlist** maintained per-repo (e.g., `{builder-bot-<repo>, patch-bot, scarlett-bot}`). This preserves legitimate non-Builder authoring against the same repo while excluding unknown identities.
- Establish the no-blocking-calls contract, the git-native pause/resume mechanic, and the filesystem boundary for non-Builder agents (no write tools, read-only source mount, fresh checkout per invocation).
- Encode Repo Hygiene in Builder's prompt: fetch latest, branch-naming, no hook bypass, no force-push on resume, run check-all before PR, cleanup after terminal state.

## Capabilities

### New Capabilities

- `system-agents`: Defines the category — what distinguishes system agents from ordinary agents, the security boundary (only reachable via authenticated operator paths), where they live (clawndom), per-agent-repo credentials and filesystem isolation requirements, and the bot-allowlist branch-protection rule.
- `builder-agent`: Defines Builder — her scope (the dispatching agent's directory only; no shared-tools, no sibling agents, no clawndom), the lifecycle state machine, the v1 deploy-webhook-driven `testable` flow, dispatch and callback HTTP contracts, idempotency, reply-context envelope, git-native pause/resume, repo hygiene baseline, and what-goes-where taxonomy enforcement.

### Modified Capabilities

<!-- None. External-provider webhook ingestion (under `agent-runner-strategy` and `webhook-proxy-domain`) is a parallel construct (HMAC-authed, third-party-driven) and is unaffected. -->

## Impact

- **clawndom**: new `src/system-agents/builder/`, route + controller for `POST /webhooks/system/builder`, internal-bearer strategy in `src/strategies/`, dedicated BullMQ queue and Builder runner registration, callback route + Redis-backed idempotency dedup, Zod schemas for dispatch / callback / resume / reply-context payloads, per-agent config extensions (Builder bot reference, branch convention, allowlist, `testable_mechanism`, supervisor webhook URL).
- **Each opting-in agent**: new `dispatch_to_builder` tool definition added to the agent's tool registry, privileged-route template variant added, tool-grant config updated so the tool is loaded only on privileged routes, declared `testable_mechanism` and operator allowlist.
- **Each opting-in agent-repo**: dedicated Builder GitHub App provisioned and installed, credentials in 1Password under `Engineering`, branch protection on `main` configured with the approved-bot allowlist (Builder + any existing legitimate bots like Patch/Scarlett).
- **Identity / infrastructure**: one Builder GitHub App per opted-in agent-repo (colocated agents share); per-agent-repo 1Password items.
- **Operational**: every Builder dispatch ends with a clawndom restart driven by the existing supervisor, after which the supervisor fires `testable` to clawndom. Per-agent operator-allowlists need review on operator changes. Per-repo bot-allowlists need review when authoring bots are added or rotated.
- **Provisioning ownership**: opting an agent (and its repo) into Builder is a one-time checklist run by you, optionally automated via outside agents (Patch / Scarlett) — never by Builder herself, to avoid the bootstrapping chicken-and-egg.
- **Out of scope**: outside agents (Patch, Scarlett) and their use against any repo from outside the runtime; extracting a generic SystemAgent framework (deferred until a second system agent justifies it); hot-reload in clawndom (filed as a separate follow-on); cross-agent improvements that span more than the dispatching agent's directory.
