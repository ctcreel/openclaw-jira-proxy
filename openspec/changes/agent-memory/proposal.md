## Why

Session-aware mode (SPE-005) gave agents continuity *within* one conversation thread (one Slack channel, one mention thread). It did not give them memory *across* conversations: Winston-in-DM cannot recall what Heather mentioned last week in `#operations`, and a brand-new session has no awareness of durable facts about the people he interacts with (relationships, preferences, ongoing work, things people have already told him). Today the only cross-thread memory is whatever the agent improvises into workspace markdown files — unstructured, unsearchable, easily forgotten by future-self.

Agents who deal with humans in conversational channels (Slack chat, email, future Telegram) need persistent, searchable, semantic memory: the ability to look up "what do I already know about this person / topic / conversation context" before responding, and to record durable facts after responding. Agents who deal with snapshot work (scheduled audits, one-shot triage, webhook routing) do not need this — adding it would just be cost.

This change introduces an opt-in, semantically-searchable memory store that templates retrieve from before composing and write to after composing.

## What Changes

- **NEW**: A `MemoryService` Clawndom subsystem that exposes store / search / prune over a vector-indexed document collection. Strategy-pattern abstractions for both the embedding provider (`EmbeddingProvider` interface) and the vector store (`VectorStore` interface) — neither is hard-coded, so the deployment can swap implementations without touching the service layer.
- **NEW**: HTTP endpoints `/api/memory/store` and `/api/memory/search` so templates can call the service via `agency_tools.memory` without dragging Redis or OpenAI clients into Python.
- **NEW**: `agency_tools.memory` Python module wrapping the HTTP API: `store(text, namespace, metadata)`, `search(query, namespace, top_k, min_similarity)`. Same shape conventions as `agency_tools.slack` and `agency_tools.google`.
- **NEW**: Optional `memory` block on routing rules:
  ```yaml
  memory:
    namespace: winston-personal
    retrieve:
      queryField: event.text
      topK: 5
      minSimilarity: 0.7
  ```
  Rules without `memory` get no behavior change. Schedule rules MAY also opt in if a recurring run wants context about its target (out of scope for v1; not blocked by this change).
- **NEW**: Pre-template memory retrieval — when a rule has `memory.retrieve`, the worker runs `MemoryService.search()` *before* template render and exposes results as `{{ memories }}` in the template. The agent sees relevant prior context without having to ask for it.
- **NEW**: Top-level `memory` config block on agents declaring namespaces:
  ```yaml
  memory:
    namespaces:
      winston-personal:
        embeddingProvider: openai
        vectorStore: redis
        pruneAfter: 365d
  ```
  Pruning runs daily; entries with `last_accessed_at < now - pruneAfter` are deleted.
- **NEW**: `memory.pruned` SSE event for observability.
- **NEW**: A new `memory-aware-agent-runner` capability under `openspec/specs/`. The capability declares the contract: opt-in retrieval, opt-in storage, namespace-scoped TTL pruning, embedding/store abstractions.

## Capabilities

### New Capabilities

- `memory-aware-agent-runner`: Pre-render retrieval, post-render storage, namespace-scoped TTL pruning, and the abstractions (EmbeddingProvider, VectorStore) that make providers swappable.

### Modified Capabilities

(none — the memory system is additive, not a modification of existing capabilities)

## Impact

- **New code**:
  - `src/services/memory/` — `memory.service.ts` (orchestrator), `embedding/` (provider strategies), `vector-store/` (store strategies), `pruning.service.ts` (scheduled cleanup)
  - `src/controllers/memory.controller.ts` — HTTP endpoints
  - `src/routes/memory.routes.ts` — route mounting
  - `src/strategies/memory-key/` — derives namespace and query for a given event (parallel to session-key strategies)
  - Worker hook for pre-render retrieval
  - Template engine extension for `{{ memories }}` interpolation
  - agency-tools Python: `agency_tools/memory/{__init__.py, _http.py, store.py, search.py}` with tests
- **New runtime dependencies**: `redis` (already running) needs RediSearch module enabled OR `better-sqlite3` + `sqlite-vec` for the local-store fallback. Embedding API: OpenAI `text-embedding-3-small`; secret plumbed through existing `SECRETS_CONFIG`.
- **Affected APIs**: New internal HTTP endpoints. No change to existing webhook controllers.
- **Affected configuration**: agent `clawndom.yaml` gains optional `memory:` top-level block + per-rule `memory:` block. Routes without it parse and run unchanged.
- **Out of scope**:
  - Auto-distillation runs (a separate post-conversation summarizer that decides what to store) — agent-decided storage in v1, distillation in a follow-up.
  - Tool-based mid-turn retrieval (agent calls `memory.search` from inside a turn) — Phase 4. Pre-render injection is the v1 retrieval mode.
  - Cross-agent shared memory namespaces — each agent owns its own namespace. Sharing semantics deferred until a real use case appears.
  - Multi-tenant Clawndom deployments. Single-instance assumption from SPE-005 carries forward.
