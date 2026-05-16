## Why

When operators ask "why did Winston do X?" or "Winston isn't replying to parents anymore," they currently have no path to a structured answer. Two existing surfaces give partial visibility — the audit log (every tool call with args + result + latency, but raw) and the dashboard (job-level state, no per-decision rationale). Both require an engineer to translate to operator language.

The pattern lands on the operator anyway: Heather flags a problem in email, Chris (the reviewer) reads the audit log + the relevant template + the routing config, forms a hypothesis, and either fixes it via Builder or relays an explanation back to Heather. The reading part is mechanical and slow; the hypothesis-forming part is what needs Chris.

This proposal introduces **Diagnostician**, the second system agent. She is the operator-callable counterpart to Builder: where Builder makes a change, Diagnostician makes a report. Operators (or Winston-on-their-behalf) ask Diagnostician "why did you do X?" or "why didn't you handle Y?"; she answers with a structured diagnostic report tying the operator's observation to specific audit-log entries, routing decisions, and template lines. She **never modifies** anything — read-only by construction.

## What Changes

- Add **Diagnostician**, a system agent in `src/system-agents/diagnostician/`. The shape mirrors Builder's (clawndom-resident, dispatched through authenticated operator paths, scoped to one dispatching agent per job) but the scope is **read-only**.
- Add a privileged dispatch route `POST /webhooks/system/diagnostician` using the existing internal-bearer signature strategy. Dispatch payload: `{agentName, question, replyContext, senderEmail, resume?}`. `agentName` is resolved against `AGENTS_CONFIG` for repo path and operator allowlist (Layer 3 enforcement).
- Add a `dispatch_to_diagnostician` tool, exposed only on **privileged routes** of opted-in agents — same structural defense as `dispatch_to_builder`. Winston's `email-chat-winston` template grows a branch for "explain X" requests from Tier 1.
- Lifecycle is shorter than Builder's: `working` (fired at job pickup), `complete` (with the structured report), `failed` (with reason). No `question_pending` — Diagnostician completes its read or fails; it never blocks for operator input.
- Reuse Builder's draft-PR-as-state pattern: Diagnostician opens a draft PR in a separate `diagnostician-reports/` repo (or a dedicated subdirectory if a separate repo is overkill) containing the report. The dispatching agent's relay sends the operator a plain-language summary + link.
- Read-only enforcement: Diagnostician has access to `gh pr view`, `gh api`, `git log`, `git show`, and clawndom's audit-log read tool. She has **no** write tools — no `gh pr merge`, no `git push` to mainline, no template-write capability. The bot identity she uses (`sc0red-diagnostician[bot]`) is granted read-only access to workspace repos via the per-repo bot allowlist.
- Encode the operator-language translation rule in Diagnostician's prompt and her report template. Same vocabulary firewall as relay-builder-callback: no "template," "route," "config," "merge," "PR," "branch," "commit" in operator-visible text.

## Capabilities

- **diagnostician-agent** — Diagnostician's behavior contract.
- **diagnostician-dispatch** — dispatch payload + lifecycle states + allowlist enforcement.
- **diagnostician-report-shape** — structured report format that operators read.

## Out of scope

- Modifying ANY agent's configuration. Diagnostician produces reports, period. If the report concludes "Winston should handle X differently," the operator forwards the report to Builder via the existing dispatch path.
- Diagnostician for non-clawndom systems. Initial scope is clawndom workspaces only. External-repo diagnosis stays with humans.
- Cross-tenant diagnosis. Each dispatch is scoped to one dispatching agent; reports do not aggregate across tenants.

## Deliverables

- OpenSpec change directory with proposal, design rationale, capability specs, and an implementation task list ordered so the read-only credentials boundary lands before any code that could be misconfigured into write access.
