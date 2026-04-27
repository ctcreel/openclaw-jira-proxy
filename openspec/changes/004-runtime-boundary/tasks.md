## Tasks

### Spec edits

- [x] Add Requirement: **Runtime / Application Boundary** to `openspec/specs/code-architecture/spec.md`. Place after "Strategy Pattern Consistency" so the layered/explicit/strategy/boundary requirements progress from intra-codebase to inter-codebase scope.
    - [x] Scenario: New Helper Adds Vendor SDK (`@gmail/api` rejected → push to agency-tools)
    - [x] Scenario: Transport Strategy Within Boundary (`@slack/socket-mode` accepted, transport not domain)
    - [x] Scenario: Per-Agent Helper Reaches Into Runtime (agent helper imports Clawndom internals → rejected)

- [x] Add Requirement: **No Agent-Specific Code Paths** to `openspec/specs/webhook-proxy-domain/spec.md`. Place after "Agent Routing" so the routing/no-agent-paths requirements sit together.
    - [x] Scenario: Agent-Named Branch in Worker (`if (agentId === 'winston')` → rejected; behavior belongs in routing rule)
    - [x] Scenario: Agent Name in Log Line (`logger.info({ agentId }, ...)` → accepted; observability, not hardcoded branch)

- [x] Add Requirement: **Transport Durability** to `openspec/specs/webhook-proxy-domain/spec.md`. Place after "No Agent-Specific Code Paths".
    - [x] Scenario: Inline Agent Run on Webhook (synchronous receive→run→reply path → rejected)
    - [x] Scenario: Slack Socket Mode Ordering (enqueue first, then ack within 3s, then async process)
    - [x] Scenario: Ack Before Enqueue Rejected (inverted ordering creates at-most-once gap → rejected)

### Verification

- [x] `make check-all` passes (no code changes; should be unaffected).
- [x] All three referenced tickets (SPE-1853, SPE-1854, SPE-1855) cited in PR description as the cases the Requirements were extracted from.
- [x] No new spec directory created — Requirements added to existing specs only.

### After merge

- [ ] Update SPE-1853, SPE-1854, SPE-1855 acceptance criteria to reference the new Requirements/Scenarios where applicable (in the next planning pass for each, not this PR).
