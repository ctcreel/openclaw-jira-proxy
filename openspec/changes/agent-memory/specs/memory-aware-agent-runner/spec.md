## ADDED Requirements

### Requirement: Memory Subsystem with Strategy-Pattern Abstractions

Clawndom SHALL provide a memory subsystem (`MemoryService`) that exposes store, search, and prune operations over a vector-indexed document collection. The subsystem MUST abstract the embedding model and the vector store as separate Strategy interfaces, registered by name, so deployments can swap implementations without touching service-layer code.

The `EmbeddingProvider` interface MUST expose:
- `name: string` — registry key
- `dimensions: number` — vector size produced
- `embed(text: string): Promise<number[]>` — single embedding
- `embedBatch(texts: readonly string[]): Promise<number[][]>` — batch embedding

The `VectorStore` interface MUST expose:
- `name: string`
- `upsert(entry): Promise<void>`
- `search(opts): Promise<readonly SearchHit[]>` — returns hits with similarity scores
- `touchAccess(id, namespace): Promise<void>` — bumps `last_accessed_at`
- `prune(opts): Promise<number>` — deletes entries by namespace + timestamp filter; returns count
- `count(namespace): Promise<number>` — for observability

#### Scenario: New embedding provider registered without service changes
- **GIVEN** A new `EmbeddingProvider` implementation `local-mini-l6`
- **WHEN** It is registered in the `embedding` strategy registry at module load
- **THEN** A namespace declaring `embeddingProvider: local-mini-l6` MUST resolve to it without any code change in `MemoryService`

#### Scenario: New vector store registered without service changes
- **GIVEN** A new `VectorStore` implementation `qdrant`
- **WHEN** It is registered in the `vector-store` strategy registry at module load
- **THEN** A namespace declaring `vectorStore: qdrant` MUST resolve to it without any code change in `MemoryService`

#### Scenario: Unknown provider rejected at startup
- **GIVEN** An agent config declaring `embeddingProvider: bogus`
- **WHEN** Clawndom loads the agent config
- **THEN** Startup MUST fail with an error naming the namespace and the unknown provider, listing the registered alternatives

### Requirement: HTTP Endpoints for Store, Search, and Delete

Clawndom SHALL expose three internal HTTP endpoints for memory operations, authenticated via the existing `CLAWNDOM_AGENT_TOKEN` mechanism:

- `POST /api/memory/store` — body: `{ namespace, text, metadata? }`. Embeds and upserts. Returns `{ id, namespace }`.
- `POST /api/memory/search` — body: `{ namespace, query, topK?, minSimilarity? }`. Embeds query, searches, bumps `last_accessed_at` on hits. Returns `{ hits: [{ id, text, metadata, score }] }`.
- `DELETE /api/memory/{id}` — body: `{ namespace }`. Removes a specific entry. Returns `{ deleted: bool }`.

All endpoints MUST validate input via Zod schemas and return 400 on invalid input. All endpoints MUST validate the bearer token and return 401 on missing/invalid auth. Server errors MUST surface as 500 with a sanitized error message (never the embedding key, never the raw vector).

#### Scenario: Store with valid input succeeds
- **GIVEN** A registered namespace `winston-personal` and a valid bearer token
- **WHEN** A POST to `/api/memory/store` arrives with `{namespace: 'winston-personal', text: 'Chris has a cat named Porter'}`
- **THEN** The endpoint MUST return 200 with `{id: <uuid>, namespace: 'winston-personal'}`
- **AND** A subsequent search for "what's the cat's name" MUST surface the entry as a top-K hit

#### Scenario: Search with valid input returns hits
- **GIVEN** Three entries in `winston-personal` with varying similarity to a query
- **WHEN** A POST to `/api/memory/search` arrives with `{namespace: 'winston-personal', query: '...', topK: 2}`
- **THEN** The endpoint MUST return up to 2 hits ranked by similarity descending
- **AND** Hits below `minSimilarity` MUST be filtered out
- **AND** Each returned hit MUST have its `last_accessed_at` updated to the current time

#### Scenario: Unauthenticated request rejected
- **GIVEN** An HTTP request to `/api/memory/store` without a bearer token
- **WHEN** The request is processed
- **THEN** The endpoint MUST return 401

#### Scenario: Unknown namespace rejected
- **GIVEN** An HTTP request to `/api/memory/store` for namespace `does-not-exist`
- **WHEN** The request is processed
- **THEN** The endpoint MUST return 400 with an error naming the unregistered namespace

### Requirement: Per-Route Retrieval Configuration

Routing rules SHALL accept an optional `memory.retrieve` block:

```yaml
memory:
  namespace: winston-personal
  retrieve:
    queryField: event.text       # field-path on the parsed payload
    topK: 5                      # required, positive integer
    minSimilarity: 0.7           # required, 0.0–1.0 inclusive
```

When present, the worker MUST resolve `queryField` against the parsed payload, call `MemoryService.search()` with the resolved value as the query, and inject the resulting hits as `{{ memories }}` in the rendered template *before* dispatching to the runner. When the field path resolves to `undefined` or a non-string, the worker MUST skip retrieval and inject an empty memories context.

When the `memory.retrieve` block is absent on a rule, the worker MUST NOT call the memory subsystem and `{{ memories }}` MUST render as an empty string in the template.

#### Scenario: Route with retrieve fetches and injects memories
- **GIVEN** A rule with `memory.retrieve.queryField: event.text`, `topK: 3`, `minSimilarity: 0.6`, `namespace: winston-personal`
- **WHEN** A matching event arrives with `event.text = 'tell me about Porter'`
- **THEN** The worker MUST call `memoryService.search` with the text as the query
- **AND** The rendered template MUST contain the top-3 hits (above 0.6 similarity) at the `{{ memories }}` interpolation point

#### Scenario: Route without retrieve renders empty memories
- **GIVEN** A rule with no `memory.retrieve` block
- **WHEN** A matching event arrives
- **THEN** The worker MUST NOT call `MemoryService.search`
- **AND** `{{ memories }}` in the rendered template MUST render as an empty string

#### Scenario: Missing query field renders empty memories
- **GIVEN** A rule with `memory.retrieve.queryField: event.text`
- **WHEN** A matching event arrives where `event.text` is undefined
- **THEN** The worker MUST skip the search call
- **AND** `{{ memories }}` MUST render as an empty string

### Requirement: Agent-Decided Storage via agency_tools.memory

The `agency_tools.memory` Python module SHALL expose:

- `store(*, text, namespace, metadata=None, agent_token, base_url) → {id, namespace}` — calls `/api/memory/store`
- `search(*, query, namespace, top_k=5, min_similarity=0.7, agent_token, base_url) → list[Hit]` — calls `/api/memory/search`
- `delete(*, id, namespace, agent_token, base_url) → {deleted: bool}` — calls `/api/memory/{id}`

The module MUST raise a `MemoryError` on non-2xx responses, mirroring the convention `agency_tools.slack._http` uses for `SlackAPIError`. The `agent_token` and `base_url` MUST be passed per call (callers own credential and endpoint state); the module reads no environment variables directly.

#### Scenario: store succeeds against a healthy endpoint
- **GIVEN** A running Clawndom with the `winston-personal` namespace registered
- **WHEN** A template calls `memory.store(text='...', namespace='winston-personal', agent_token=$TOKEN, base_url='http://localhost:8794')`
- **THEN** The call MUST return `{id: <uuid>, namespace: 'winston-personal'}`

#### Scenario: store on unknown namespace raises MemoryError
- **GIVEN** A running Clawndom without the `bogus-ns` namespace
- **WHEN** A template calls `memory.store(text='...', namespace='bogus-ns', ...)`
- **THEN** The call MUST raise `MemoryError` with the 400 error message

### Requirement: Per-Namespace TTL Pruning

Each agent's `clawndom.yaml` SHALL declare its memory namespaces and per-namespace policy under a top-level `memory:` block:

```yaml
memory:
  namespaces:
    winston-personal:
      embeddingProvider: openai
      vectorStore: redis
      pruneAfter: 365d            # required duration string
```

A daily Clawndom-internal scheduled task MUST run `vectorStore.prune({namespace, olderThan: now - pruneAfter})` for each declared namespace. The prune MUST delete entries whose `last_accessed_at < now - pruneAfter`. The prune MUST emit a `memory.pruned` SSE event with `{namespace, deletedCount, durationMs}`.

The default `pruneAfter` SHALL be 365 days when not specified.

#### Scenario: Daily prune deletes stale entries
- **GIVEN** A namespace with `pruneAfter: 365d` and an entry with `last_accessed_at` 400 days ago
- **WHEN** The daily prune runs
- **THEN** The entry MUST be deleted from the vector store
- **AND** A `memory.pruned` event MUST be published with `deletedCount >= 1`

#### Scenario: Recently-accessed entries survive prune
- **GIVEN** An entry that was created 400 days ago but `last_accessed_at` is 10 days ago
- **WHEN** The daily prune runs against `pruneAfter: 365d`
- **THEN** The entry MUST NOT be deleted (recency of access wins over age)

#### Scenario: Search bumps last_accessed_at
- **GIVEN** An entry returned as a search hit
- **WHEN** The hit is included in the search response
- **THEN** The entry's `last_accessed_at` MUST be updated to the current timestamp before the response returns

### Requirement: Lifecycle Observability via SSE Events

The memory subsystem SHALL emit lifecycle events to the existing SSE bus matching the convention used by `slack-socket-transport` and the SessionPool:

- `memory.stored` — `{namespace, id, textLength}` (no full text in the event payload — operators see counts/ids, not content)
- `memory.retrieved` — `{namespace, queryLength, hitCount, topScore?}`
- `memory.pruned` — `{namespace, deletedCount, durationMs}`
- `memory.error` — `{namespace?, operation, errorMessage}` for store/search/prune failures

Each event MUST include `timestamp` and `traceId` fields per the existing convention. Events MUST also be logged at info level (errors at error).

#### Scenario: Store emits memory.stored
- **GIVEN** A store call to `winston-personal` with `text="..."`
- **WHEN** The store completes
- **THEN** A `memory.stored` SSE event MUST be published with `namespace: 'winston-personal'`, the new `id`, and the `textLength`

#### Scenario: Search emits memory.retrieved
- **GIVEN** A search call returning N hits
- **WHEN** The search completes
- **THEN** A `memory.retrieved` SSE event MUST be published with `hitCount: N` and the top hit's score (when N > 0)

#### Scenario: Failed embedding emits memory.error
- **GIVEN** An OpenAI API outage
- **WHEN** A store or search call's embedding step fails
- **THEN** A `memory.error` SSE event MUST be published with `operation` and a sanitized `errorMessage`
- **AND** The HTTP endpoint MUST return 500 with the sanitized message

### Requirement: Storage Rate Limit Per Agent Run

The `MemoryService.store` operation SHALL enforce a per-run rate limit on calls from a single agent run, default 5 stores per run, per namespace, per traceId. Calls beyond the limit MUST return a 429 from the HTTP endpoint and emit `memory.error` with `operation: 'store'` and `errorMessage: 'rate-limit-exceeded'`. The limit SHALL be configurable per namespace via `memory.namespaces.<name>.maxStoresPerRun`.

#### Scenario: 6th store within one run is rejected
- **GIVEN** A namespace with `maxStoresPerRun: 5` and an agent run that has already made 5 store calls
- **WHEN** The 6th store call arrives with the same `traceId`
- **THEN** The endpoint MUST return 429
- **AND** A `memory.error` event MUST be published

#### Scenario: Store calls in different runs do not share the limit
- **GIVEN** Two different agent runs (different `traceId` values)
- **WHEN** Each run makes 5 store calls in the same namespace
- **THEN** All 10 stores MUST succeed (limit is per-run, not per-namespace globally)

### Requirement: Configuration-Time Validation

At Clawndom startup, the agent loader SHALL validate the following memory-related cross-cuts that Zod cannot catch on the schema alone:

- Every routing rule's `memory.namespace` MUST refer to a namespace declared in the agent's `memory.namespaces` block. Unknown namespace → fail-fast with a clear error.
- Every namespace's `embeddingProvider` MUST resolve to a registered EmbeddingProvider name.
- Every namespace's `vectorStore` MUST resolve to a registered VectorStore name.
- No two agents MAY declare the same namespace name. Cross-agent contamination prevention.
- `topK` MUST be a positive integer; `minSimilarity` MUST be in `[0.0, 1.0]`; `pruneAfter` and `maxStoresPerRun` MUST parse cleanly.

#### Scenario: Rule references undeclared namespace
- **GIVEN** A rule with `memory.namespace: missing-ns` and no `memory.namespaces.missing-ns` block
- **WHEN** Clawndom loads the agent config
- **THEN** Startup MUST fail with an error naming the rule and the missing namespace

#### Scenario: Two agents declare the same namespace
- **GIVEN** Agent A and Agent B both declare `memory.namespaces.shared`
- **WHEN** Clawndom loads both agent configs
- **THEN** Startup MUST fail with an error naming both agents and the conflicting namespace

#### Scenario: minSimilarity out of bounds
- **GIVEN** A rule with `memory.retrieve.minSimilarity: 1.5`
- **WHEN** Clawndom loads the agent config
- **THEN** Startup MUST fail with a schema validation error
