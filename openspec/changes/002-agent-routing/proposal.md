## Change: Agent Routing Strategy

### Summary

Add configurable per-provider routing rules that determine which OpenClaw agent receives each webhook event, using a Strategy pattern consistent with the existing signature validation architecture.

### Motivation

Currently, all events from all providers route to a single hardcoded `agentId` (global `OPENCLAW_AGENT_ID`). As the proxy serves multiple agents (Patch, Scarlett, Sasha, etc.), events need to reach the right agent based on payload content — assignee, labels, event type, or custom fields.

### Design

**Strategy pattern** — mirrors `src/strategies/signature/`:

```
src/strategies/routing/
  types.ts          — RoutingStrategy interface, RoutingRule type, RoutingConfig schema
  registry.ts       — Strategy registry (register + resolve by name)
  field-equals.ts   — Exact match on a dot-notation field path
  regex.ts          — Regex match with optional flags
  default.ts        — Always-match fallback
  resolve.ts        — resolveAgent(payload, routingConfig, globalDefault) → agentId | null
  index.ts          — barrel export
```

**Field resolution:** Dot-notation path accessor (e.g., `issue.fields.labels`) — simple recursive lookup, no external dependency. Array values are tested element-wise.

**Config schema extension** — `PROVIDERS_CONFIG` entries gain an optional `routing` key:

```typescript
const routingRuleSchema = z.object({
  strategy: z.string().min(1),
  field: z.string().optional(),    // not needed for "default"
  value: z.string().optional(),    // field-equals
  pattern: z.string().optional(),  // regex
  flags: z.string().optional(),    // regex flags
  agentId: z.string().min(1),
});

const routingConfigSchema = z.object({
  rules: z.array(routingRuleSchema).default([]),
  default: z.string().optional(),  // fallback agentId
}).optional();
```

**Worker integration:** Before the HTTP POST, worker calls `resolveAgent(parsedPayload, provider.routing, settings.openclawAgentId)`. Result becomes the `agentId` in the envelope. If `null` (no match, no default), job completes with a warning log — no POST.

### Backward Compatibility

- If `routing` is absent from a provider config → routes to `OPENCLAW_AGENT_ID` (current behavior)
- No breaking changes to existing `PROVIDERS_CONFIG` format
- Global `OPENCLAW_AGENT_ID` remains the ultimate fallback

### Files

| File | Action | Lines |
|------|--------|-------|
| `src/strategies/routing/types.ts` | New | ~30 |
| `src/strategies/routing/registry.ts` | New | ~20 |
| `src/strategies/routing/field-equals.ts` | New | ~25 |
| `src/strategies/routing/regex.ts` | New | ~30 |
| `src/strategies/routing/default.ts` | New | ~10 |
| `src/strategies/routing/resolve.ts` | New | ~30 |
| `src/strategies/routing/index.ts` | New | ~5 |
| `src/config.ts` | Modify | +15 (schema) |
| `src/services/worker.service.ts` | Modify | +5 (call resolveAgent) |
| `tests/unit/strategies/routing/*.test.ts` | New | ~200 |
| `tests/unit/services/worker.service.test.ts` | Modify | +30 (routing cases) |

### Estimation

- **Risk:** Low — additive, no changes to existing processing flow
- **Intensity:** Low — Strategy pattern already established, config schema already Zod-validated
- **Story Points:** 3
- **Total new code:** ~150 lines source + ~230 lines tests
