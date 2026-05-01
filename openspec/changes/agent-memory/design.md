## Context

Agents that act as conversational interfaces (Winston-in-Slack, future email agents) need to know two things every time a human pings them: who is this person and what have they told me before, and what's the current ask. The session-aware runner from SPE-005 covers (b) within a single thread; for (a) across threads, the agent has no built-in memory.

Workspace markdown files (e.g. `memory/` directories) are the workaround Winston has been using ad hoc — but they're keyword-grep at best, and the agent has to remember to consult them. There is no way to ask "what do I know about this person, topic, or context" without inventing a per-shape file convention. As more agents (Scarlett, Marlowe, Sasha) come online, each will reinvent the same primitive incompatibly.

This change introduces a single semantically-searchable memory store with retrieval and storage as opt-in routing primitives. The vector store is abstracted so deployments can run on Redis (already up for BullMQ + sessions; needs RediSearch module) or sqlite-vec (file-based, dead-simple, no infra). The embedding service is abstracted so we can use OpenAI (cheap, fast, good) or a local sentence-transformer (free, more deps) or a future Anthropic embeddings API without rewriting consumers.

## Goals / Non-Goals

**Goals:**

- Per-route opt-in: routes that want memory declare it; routes that don't, get unchanged behavior. Memory is a feature you turn on, not a tax everyone pays.
- Strategy abstractions for embeddings and vector stores. Adding a new provider is a new file implementing the interface, registered by name. No core code changes.
- Pre-render retrieval: relevant memories are pulled before the template is rendered and exposed via `{{ memories }}` interpolation. The agent reads them as part of its prompt without having to think about retrieval.
- Agent-decided storage: the template instructs the agent to call `memory.store()` for durable facts. Simple, transparent, easy to debug.
- TTL-based pruning: memories that haven't been accessed in N days (default 365) are deleted on a daily schedule. Bounded growth.
- Independent test of the subsystem before integrating with Winston: the memory layer is provable on its own (HTTP endpoints + agency-tools client + fake providers) before the slack-chat template starts using it.
- Observability via the existing SSE event bus: `memory.stored`, `memory.retrieved`, `memory.pruned`, `memory.error`. Operators see what's happening without log-grepping.

**Non-Goals:**

- **Auto-distillation.** A separate process that watches conversations and decides what to store is interesting but out of scope. The template asks the agent to store; that's enough for v1.
- **Tool-based retrieval mid-turn.** Letting the agent call `memory.search` from inside a turn (vs. having pre-render injection) is more flexible but more complex. Phase 4. Pre-render covers the 80%.
- **Cross-agent sharing of memories.** Each agent owns its own namespaces. If two agents need to share memory, that's a real design problem (whose privacy? whose voice? whose deletion authority?) — defer until use case appears.
- **Re-ranking, hybrid search, query expansion, conversation-aware retrieval.** The retrieval layer is a top-K nearest-neighbor search with a similarity floor. Sophistication can be layered later.
- **Multi-instance Clawndom deployments.** Single-instance assumption from SPE-005 carries forward — namespace pruning runs on a single node.
- **Per-memory access control.** All memories in a namespace are equally readable by anything querying that namespace. If a memory shouldn't be in a namespace, don't store it there.

## Decisions

### Decision 1: Strategy pattern for both embeddings and vector stores

The memory subsystem has two pluggable axes: how text becomes vectors, and where vectors live. Both have a small, well-defined interface; both have multiple plausible implementations; both will be touched independently as we evolve. This is the textbook Strategy use case.

**EmbeddingProvider** interface:

```ts
interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}
```

Implementations: `openai-text-embedding-3-small` (default), `null-fake` (deterministic-from-hash, used in tests), `local-sentence-transformer` (Phase 2; subprocess wrapper).

**VectorStore** interface:

```ts
interface VectorStore {
  readonly name: string;
  upsert(entry: MemoryEntry): Promise<void>;
  search(opts: SearchOptions): Promise<readonly SearchHit[]>;
  touchAccess(id: string, namespace: string): Promise<void>;
  prune(opts: PruneOptions): Promise<number>;  // returns count deleted
  count(namespace: string): Promise<number>;
}
```

Implementations: `redis-search` (default; uses RediSearch FT.SEARCH), `sqlite-vec` (Phase 2; file-based fallback), `in-memory` (used in tests).

Registries are name-keyed; namespace config picks providers by name. Adding a new vector store or embedding provider is a new file, register at module load time, namespace config can use it.

Rejected alternative: a single monolithic `MemoryStore` class wrapping everything. Less flexibility, ties the embedding choice to the store choice.

### Decision 2: HTTP endpoints + Python client, not direct Redis from Python

`agency_tools.memory` runs in claude-cli subprocesses (Python). It needs to call the memory service. Two options:

- (a) Python connects directly to Redis + OpenAI. Memory orchestration logic ends up in agency-tools.
- (b) Clawndom owns the orchestration, exposes HTTP endpoints; Python calls the endpoints.

Going with (b). Reasons:
- Single source of truth for namespace policy (TTL, embedding provider selection, vector store selection) — lives in Clawndom, not duplicated across language clients.
- Agency-tools stays a thin wrapper. Same pattern as `agency_tools.slack` (HTTP wrappers around Slack Web API) and the existing `/api/tasks` endpoint Winston uses for inter-agent dispatch.
- Auth is the same as `/api/tasks` — the existing `CLAWNDOM_AGENT_TOKEN`.
- Future agents in other languages (Go, Ruby) get a uniform interface.

Rejected alternative: direct Redis access from Python. Faster (no HTTP hop) but couples agency-tools to specific store implementations and forces every consumer to re-implement namespace policy.

### Decision 3: Routing config carries the retrieval contract; agent decides storage

Retrieval config lives on the route:

```yaml
memory:
  namespace: winston-personal
  retrieve:
    queryField: event.text          # field-path on parsedPayload
    topK: 5
    minSimilarity: 0.7
```

The worker reads `queryField` against the parsed payload, calls `memoryService.search()`, exposes results as `{{ memories }}` in the template. **Configuration-driven**: same expressivity as the existing `signatureStrategy` / `contextStrategy` / `sessionKey` strategies.

Storage is **agent-decided**. The template instructs the agent: "If the user told you something durable about themselves or their world, call `memory.store(text=..., metadata=...)`." The agent decides what's durable. Storage is opt-in within the run.

Why not auto-extract durable facts after every run? Because the agent knows context the extractor doesn't. "My dog's name is Rex" stored alone is a useful fact; "Rex was barking" is not. Letting the agent judge keeps memory clean.

Rejected alternative: store every assistant_text as a memory and let retrieval do the filtering. Wasteful — most assistant turns are situation-specific, not durable. Cost would balloon (embeddings cost per memory) and retrieval quality would tank (relevant facts buried in noise).

### Decision 4: Pre-render injection over tool-based retrieval (for v1)

When the route has `memory.retrieve`, the worker fetches before template render and inlines results as `{{ memories }}`. The agent sees them as plain prompt context.

Tool-based retrieval (`memory.search` as a tool the agent calls mid-turn) is more flexible — the agent can ask follow-up queries based on the conversation — but adds round-trips and prompt complexity. Defer to Phase 4 once we know whether pre-render is enough.

For Winston specifically: pre-render injection of the top-5 memories most semantically similar to the inbound message text is sufficient ~95% of the time.

### Decision 5: Namespace TTL on access timestamp (LRU-style), not creation timestamp

Pruning policy: delete entries where `last_accessed_at < now - pruneAfter`.

Why access-based not creation-based:
- A fact stored 3 years ago that's still being retrieved every week is *useful* — we shouldn't delete it.
- A fact stored yesterday that nobody ever asks about is noise — even if recent, it's not earning its keep.
- Access-based naturally surfaces "what matters" without explicit relevance scoring.

Implementation: every successful search result has its `last_accessed_at` bumped to `now()`. Daily prune runs `delete WHERE last_accessed_at < now - pruneAfter`. Default 365 days; per-namespace tunable.

Rejected alternatives:
- Creation-based: deletes useful old facts.
- Relevance score decay: more sophisticated but harder to reason about; not worth the complexity for v1.
- No pruning: unbounded growth, eventually slows search and bloats embedding costs.

### Decision 6: Single namespace per route, configurable per agent

Each route declares one namespace (`memory.namespace: winston-personal`). The agent's `clawndom.yaml` declares which namespaces exist and what their policy is:

```yaml
memory:
  namespaces:
    winston-personal:
      embeddingProvider: openai
      vectorStore: redis
      pruneAfter: 365d
```

The agent owns its namespaces; routes attach to them. This matches how the agent's other workspace state (memory files, log files) is scoped: per-agent.

Cross-namespace search is not supported. If Winston has two namespaces (`winston-personal` for people-facts, `winston-projects` for ongoing work), each route picks one. A route that needs to query both would need to be split or use the union namespace pattern at config time.

### Decision 7: OpenAI text-embedding-3-small as the v1 default

- 1536 dimensions, $0.02 per 1M tokens, ~50ms latency. Practical and cheap.
- Anthropic doesn't ship embeddings.
- Local sentence-transformers (e.g. `all-MiniLM-L6-v2`) is free but adds a Python subprocess dependency; reserve for the offline / privacy-sensitive case as a Phase 2 addition.

Stored vector dimension is fixed per namespace at namespace creation time. Changing embedding provider on an existing namespace = re-embed all entries (offline migration; not in scope for v1).

### Decision 8: RediSearch as the v1 default vector store

Redis is already running (BullMQ + dedup + sessions). RediSearch (the search module) supports vector indexing via FT.CREATE and KNN search via FT.SEARCH. We get vector search without adding a new service.

If a deployment doesn't have RediSearch (vanilla Redis), fall back to sqlite-vec — file-based, lives in workspace, zero infrastructure, slower at large scale but fine for low-volume agents. The strategy pattern means swapping is one config change.

For Winston's scale (hundreds to maybe thousands of memories over a year), either backend handles it sub-100ms.

## Risks / Trade-offs

- **[Risk]** Embedding cost on hot paths. Every retrieval does one embedding (the query); every store does one embedding. ~$0.0001 per turn at OpenAI's pricing — trivial in absolute terms but unbounded if a runaway loop calls `memory.store` thousands of times. **→ Mitigation**: rate-limit store calls per turn (e.g. max 5 stores per agent run); document the limit; emit `memory.error` on exceed.
- **[Risk]** Embedding provider outage halts retrieval. **→ Mitigation**: retrieval failures fall back to "no memories" (template still renders, agent still answers, just without prior context). Storage failures are logged and surfaced via `memory.error` SSE event but don't fail the agent run. The system stays operational with degraded recall.
- **[Risk]** Stored memories drift from agent's actual model voice. The agent stores "Chris likes blue" in his own words; six months later he reads it back and the wording feels alien. **→ Mitigation**: agent decides storage wording at the moment of storage; future-self reads it as text and incorporates as it would any other context. This is fundamentally a model-coherence question, not a memory-system question.
- **[Risk]** TTL-based pruning deletes useful-but-rarely-accessed memories. "I have a peanut allergy" might not get retrieved often but is critical. **→ Mitigation**: 365-day default is generous; access-bumping naturally protects anything ever queried in that window. The first-line fix for false-positive prunes is to bump pruneAfter for the namespace. Future-Phase: explicit "pinned memory" flag that exempts from pruning.
- **[Risk]** Memory pollution — agent stores something incorrect or one-off as durable, retrieves it later as truth. **→ Mitigation**: stored entries include the conversation context they came from in metadata. Operator can `redis-cli` to inspect and `memory.delete()` (HTTP endpoint) to remove. Document the diagnostic procedure.
- **[Risk]** Cross-agent contamination if namespaces are mistakenly shared. **→ Mitigation**: validate at config-load time that no two agents declare overlapping namespace names. Fail fast at startup.
- **[Risk]** Vector dimension mismatch on provider change. **→ Mitigation**: namespace stores `embeddingProvider` name; refusing to store/search with a different provider's dimension count. Migration is an explicit re-embed pass, out of scope here.
- **[Trade-off accepted]** No multi-instance Clawndom. Pruning, search, and storage assume one node owns the namespace. Multi-instance deployments need cross-instance coordination (lease-based pruning, distributed similarity search) which is out of scope.

## Migration Plan

1. **Phase 1: subsystem standalone.** Build the MemoryService, EmbeddingProvider/VectorStore strategies, HTTP endpoints, agency-tools client, pruning scheduler, observability events. Unit tests against in-memory + null-fake providers; integration tests against Redis + (optional) real OpenAI. Ship to clawndom main with no consumer.

2. **Phase 2: Winston opt-in (test).** Add `memory:` block to a non-production Winston route (e.g. a test channel) with a small `pruneAfter` for fast iteration. Verify retrieval surfaces relevant facts; verify storage works; verify daily prune triggers. Adjust thresholds.

3. **Phase 3: Winston Slack chat opt-in.** Add `memory:` to `routing.slack-winston.rules[0].chat`. Update slack-chat.md template: add `## Step 0 — Read your memories` (consult `{{ memories }}` before composing) and `## Step 5.5 — Store new memories` (call `memory.store` for durable facts).

4. **Phase 4: gmail-heather opt-in.** Inbox triage benefits from "what do I already know about this sender / topic." Lower priority; ship after Slack works.

Rollback: remove `memory:` from the route and restart. Routes revert to no-memory behavior. Stored data persists in Redis; can be flushed if desired.

## Open Questions

1. **Should `agency_tools.memory.store` be idempotent on duplicate text?** Embedding the same text twice creates two memories, which retrieval would dedupe by similarity but stores two entries. Probably want a hash-based skip on identical normalized text within a namespace. Decide during implementation.

2. **Rate limit on store calls per run.** Hardcode 5? Configurable? Probably configurable per-namespace; default 5 is sane.

3. **What metadata schema?** `metadata: Record<string, unknown>` is permissive but means schema drift across agents. Probably want a recommended subset (`source`, `recordedAt`, `conversationId`) without enforcing.

4. **`memory.delete()` API surface.** Operator-facing only? Or should the agent be able to delete? Risk of agent-driven self-corruption argues for operator-only. Decide during implementation.

5. **Embedding cache.** Re-embedding the same query text repeatedly is wasteful. Add a simple TTL'd LRU cache on query embeddings? Phase 1 ships without; add if warranted.
