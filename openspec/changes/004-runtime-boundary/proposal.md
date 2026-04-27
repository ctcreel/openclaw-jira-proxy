## Change: Runtime / Application Boundary + Transport Durability

### Summary

Codify three cross-cutting requirements that have come up repeatedly across recent Clawndom tickets and would otherwise drift between PRs. The Requirements land in existing specs (`code-architecture` and `webhook-proxy-domain`), each with WHEN/THEN scenarios so reviewers can evaluate concrete cases instead of debating principles inline.

The three new Requirements:

1. **Runtime / Application Boundary** (added to `code-architecture`) — Clawndom is a runtime; domain helpers belong in `agency-tools`, not in Clawndom.
2. **No Agent-Specific Code Paths** (added to `webhook-proxy-domain`) — Per-agent behavior expresses in agent config (routing rules, condition AST, templates), never in Clawndom source.
3. **Transport Durability** (added to `webhook-proxy-domain`) — Every inbound event enqueues to BullMQ before agent work begins. Hard-timeout transports (Slack Socket Mode's 3-second ack window) acknowledge BEFORE enqueueing, not after agent run completion.

### Motivation

Recent and active tickets — SPE-1853 (Slack Socket Mode), SPE-1854 (Clawndom `sharedTools`), SPE-1855 (`agency-tools` scaffold + `google_api.py` extraction) — each touch the line between Clawndom's runtime and agent-specific code. Without explicit Requirements + Scenarios, each PR re-litigates the same boundary question and the eventual answer is enforced by individual reviewer judgment instead of by the spec system.

Concrete cases the boundary needs to settle:

- A PR that adds `@gmail/api` to Clawndom's dependencies — should be rejected and pushed to `agency-tools`.
- A PR that adds `@slack/socket-mode` to Clawndom's dependencies — should be accepted because Socket Mode is transport, not domain logic.
- A PR that adds `if (agentId === 'winston') { ... }` to a Clawndom service — should be rejected and the behavior expressed in Winston's `clawndom.yaml` instead.
- A new transport that runs the agent inline before responding to the inbound request — should be rejected because it loses work on restart and breaks per-provider serialization.

These three Requirements make those calls predictable.

### Design

The new Requirements are extensions to existing specs, not a new spec domain:

- `code-architecture/spec.md` — already contains "Layered Architecture" and "Explicit Over Implicit" Requirements about boundaries within the codebase. The Runtime / Application Boundary is the same kind of Requirement at a different layer (runtime vs application code), so it fits naturally here.
- `webhook-proxy-domain/spec.md` — already contains "Multi-Provider Webhook Ingestion", "Per-Provider Queue Isolation", "Completion-Aware Processing", "Agent Routing", "Configuration Schema". The two new Requirements (No Agent-Specific Code Paths, Transport Durability) extend the existing domain coverage; both fit the spec's purpose statement ("the core domain behavior of the OpenClaw webhook proxy").

No new spec directory is created. All edits are additive.

### Backward Compatibility

This change is documentation only. No existing Requirements are modified or removed. Existing code already satisfies the new Requirements (verified by inspection of the three referenced tickets — they were drafted with these constraints implicit). No code changes, no test changes, no behavior changes.

### Files

| File | Action | Notes |
|------|--------|-------|
| `openspec/changes/004-runtime-boundary/proposal.md` | New | This file |
| `openspec/changes/004-runtime-boundary/tasks.md` | New | Concrete spec edits checklist |
| `openspec/specs/code-architecture/spec.md` | Modify | Add Requirement: Runtime / Application Boundary + 3 scenarios |
| `openspec/specs/webhook-proxy-domain/spec.md` | Modify | Add Requirement: No Agent-Specific Code Paths + 1 scenario |
| `openspec/specs/webhook-proxy-domain/spec.md` | Modify | Add Requirement: Transport Durability + 2 scenarios |

### Estimation

- **Risk:** None — documentation only
- **Intensity:** Low — three Requirements, six scenarios, no code changes
- **Story Points:** 1
