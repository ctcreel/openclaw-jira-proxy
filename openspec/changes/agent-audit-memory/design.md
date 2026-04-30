## Context

The agent-memory change gave Clawndom a vector-backed memory subsystem with store, search, and prune operations. It was designed for agent-facing memory (durable facts about people and context). This change extends the same infrastructure to operator-facing audit: automatic storage of agent reasoning so past decisions are semantically searchable.

The key constraint is that `RunResult` does not carry the assistant's full text — it only has status, runId, and timestamps. The full reasoning streams through `runner.assistant_text` events during the run but is not captured anywhere persistent except the truncated pino log. To store it, the worker must accumulate text chunks during the run and flush them to memory after completion.

## Goals / Non-Goals

**Goals:**

- Zero-config for agents that don't want audit. Opt-in via a `memory.audit` block.
- Per-provider filtering: an agent may want to audit Gmail triage decisions but not Slack chats (which are already conversational and stored in session).
- Use the existing MemoryService — no new storage layer, no new embedding pipeline, no new pruning scheduler.
- One memory entry per job, not per text chunk. The stored text is the concatenation of all `runner.assistant_text` events from the run. This keeps storage bounded (one embedding call per job, one vector per job).
- Searchable by semantic similarity: "rental inquiry draft skip" should find the Culotta reasoning even if the word "Culotta" doesn't appear in the query.

**Non-Goals:**

- **Summarization before storage.** Storing the full concatenated text is simpler and preserves detail. If a 20KB triage run output is too large for embedding quality, we can add a summarization step later.
- **Agent self-awareness.** Audit memory is not injected into prompts. The agent doesn't know its past decisions were stored. If we want agents to learn from their own audit trail, that's a separate retrieval binding.
- **Replacement for pino logs.** The log file continues to exist. Audit memory is for semantic search; logs are for sequential debugging and infrastructure monitoring.
- **Real-time audit queries.** No streaming endpoint for "what is Winston doing right now?" — that's the existing SSE event bus.

## Decisions

### Decision 1: Accumulate in the worker, store on completion

The worker already orchestrates the full lifecycle: parse → route → render → dispatch → wait → publish events. Adding text accumulation and a post-completion store call is a natural extension of this flow.

**Implementation:**

```typescript
// In processJob(), before dispatching to runner:
const assistantTextChunks: string[] = [];

// Subscribe to the run's assistant_text events:
const unsubscribe = events.subscribe('runner.assistant_text', (event) => {
  if (event.jobId === jobIdString) {
    assistantTextChunks.push(event.text);
  }
});

// After runner completes successfully:
unsubscribe();

if (auditConfig && auditConfig.providers.includes(provider.name)) {
  const fullText = assistantTextChunks.join('\n\n');
  if (fullText.length > 0) {
    await memoryService.store({
      namespace: auditConfig.namespace,
      text: fullText.slice(0, 8000),  // Cap at ~2 embedding pages
      metadata: {
        source: `audit:${provider.name}`,
        jobId: jobIdString,
        traceId,
        agentId,
        provider: provider.name,
        template: templatePath,
        recordedAt: new Date().toISOString(),
      },
      traceId: `audit-${traceId}`,  // Separate trace to avoid rate-limit collision
    });
  }
}
```

**Why not store from a separate event subscriber?** A standalone subscriber would need to correlate text chunks by jobId, track job completion, and manage its own lifecycle. The worker already has all of this context. Adding 15 lines to the worker is simpler than a new service.

### Decision 2: One entry per job, capped text length

Embedding models have token limits and diminishing quality on very long inputs. A single triage run might produce 5-10KB of reasoning. Storing the full text as one entry (capped at ~8000 chars, roughly 2000 tokens) keeps:
- One embedding call per job (cost-bounded)
- One vector per job (search returns job-level results, not fragment-level)
- Metadata attached to the whole decision, not individual sentences

If the text exceeds the cap, it's truncated with a `[truncated]` marker. The full text remains in the pino log for sequential debugging — audit memory is for semantic search, not archival.

### Decision 3: Config schema

```yaml
memory:
  namespaces:
    winston-audit:
      embeddingProvider: openai
      vectorStore: redis
      pruneAfter: 90d
      maxStoresPerRun: 1
  audit:
    namespace: winston-audit       # must reference a declared namespace
    providers:                     # which provider runs to audit
      - gmail-heather
      - gmail-winston
```

The `audit` block is optional. When present:
- `namespace` must reference a namespace declared in `memory.namespaces` (validated at load time, same as `memory.retrieve.namespace`).
- `providers` is a list of provider names. Only runs triggered by these providers are audited. Omitting the list or setting it to `["*"]` audits all providers.
- `maxStoresPerRun: 1` is the recommended default for audit namespaces — one store per job is sufficient.

### Decision 4: Separate trace ID for audit stores

The audit store call uses `audit-${traceId}` as its trace ID, not the job's own `traceId`. This prevents the audit store from consuming the agent's per-run rate budget in other namespaces. The audit namespace has its own `maxStoresPerRun` (typically 1), and the `audit-` prefix ensures the rate limiter treats it as a separate budget.

## File Changes

| File | Change |
|---|---|
| `src/services/agent-loader.service.ts` | Add `auditSchema` to agent config, validate namespace reference |
| `src/services/memory/config-schemas.ts` | Add `auditConfigSchema` Zod schema |
| `src/services/worker.service.ts` | Accumulate assistant text, store on completion |
| `src/types/clawndom-event.ts` | Add `memory.audit_stored` event type |
| Tests | Worker audit path, config validation, provider filtering |
