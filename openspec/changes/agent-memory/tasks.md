## 1. Schema and configuration

- [ ] 1.1 Add `memorySchema` (top-level agent block: `namespaces: Record<string, NamespaceConfig>`) and per-rule `memoryRetrieveSchema` to `src/services/agent-loader.service.ts`. NamespaceConfig fields: `embeddingProvider`, `vectorStore`, `pruneAfter` (duration → ms), `maxStoresPerRun` (default 5).
- [ ] 1.2 Per-rule retrieve config: `namespace`, `retrieve: {queryField, topK, minSimilarity}`. `topK` positive integer; `minSimilarity` in `[0.0, 1.0]`. `retrieve` is optional — rules can opt into storage-only by declaring just `namespace`.
- [ ] 1.3 Implement `validateMemoryConfig(agentName, config)` analogous to `validateSessionConfig`: rejects unknown providers/stores, rejects rules referencing undeclared namespaces, rejects cross-agent namespace name collisions (registry-wide check at the loader level).
- [ ] 1.4 Unit tests for schema acceptance, undeclared-namespace rejection, unknown-provider rejection, cross-agent collision, out-of-range minSimilarity, malformed durations.

## 2. EmbeddingProvider strategy

- [ ] 2.1 Define `EmbeddingProvider` interface in `src/services/memory/embedding/types.ts` (`name`, `dimensions`, `embed`, `embedBatch`).
- [ ] 2.2 Implement `OpenAIEmbeddingProvider` in `src/services/memory/embedding/openai.ts` using `text-embedding-3-small` (1536 dims). API key resolved via `SecretManager` (logical key `openai_api_key`). HTTP via existing `node:fetch`-style approach used elsewhere; no new client dependency.
- [ ] 2.3 Implement `NullEmbeddingProvider` in `src/services/memory/embedding/null.ts` for tests: deterministic vector from `crypto.createHash('sha256').update(text).digest()` mapped to 64 floats. Same input → same vector.
- [ ] 2.4 Registry in `src/services/memory/embedding/index.ts` with `register`, `getEmbeddingProvider(name)`, `listEmbeddingProviders()`. Eager-register `openai` and `null-fake`.
- [ ] 2.5 Tests: each provider's contract, registry add/get/list, `embedBatch` semantics (preserves order, handles empty input).

## 3. VectorStore strategy

- [ ] 3.1 Define `VectorStore` interface in `src/services/memory/vector-store/types.ts` (`name`, `upsert`, `search`, `touchAccess`, `prune`, `count`). Define `MemoryEntry`, `SearchOptions`, `SearchHit`, `PruneOptions` types.
- [ ] 3.2 Implement `RedisVectorStore` in `src/services/memory/vector-store/redis.ts` using RediSearch FT.* commands. Index name: `memory-{namespace}` with vector field via FT.CREATE on first use; idempotent. Schema: `text TEXT`, `metadata TEXT (JSON)`, `vector VECTOR FLAT 6 DIM <dims> TYPE FLOAT32 DISTANCE_METRIC COSINE`, `createdAt NUMERIC SORTABLE`, `lastAccessedAt NUMERIC SORTABLE`. Use existing Redis singleton.
- [ ] 3.3 Implement `InMemoryVectorStore` in `src/services/memory/vector-store/in-memory.ts`: `Map<id, MemoryEntry>` with linear-scan cosine similarity. Used in unit tests; not for production.
- [ ] 3.4 Registry in `src/services/memory/vector-store/index.ts` with `register`, `getVectorStore(name)`, `listVectorStores()`. Eager-register `redis` and `in-memory`.
- [ ] 3.5 Tests: upsert + search round-trip, top-K ordering by similarity, minSimilarity floor, touchAccess updates timestamp, prune deletes only old entries, count returns correct per-namespace count. Run against `InMemoryVectorStore` in unit; against real Redis in integration tests.

## 4. MemoryService orchestration

- [ ] 4.1 `src/services/memory/memory.service.ts` exposing `store({namespace, text, metadata, traceId})`, `search({namespace, query, topK, minSimilarity, traceId})`, `delete({namespace, id})`, `prune({namespace})`. Constructor takes `{embeddingProviderRegistry, vectorStoreRegistry, namespaceConfigs, secretManager, eventBus, redis}` so it's testable without globals.
- [ ] 4.2 Per-namespace embedding-provider + vector-store resolution: cached at startup based on `NamespaceConfig`. Service rejects calls to undeclared namespaces with a typed error (`UnknownNamespaceError`).
- [ ] 4.3 Per-run rate limiting: in-memory `Map<traceId, Map<namespace, count>>` with TTL eviction (key cleared 5 minutes after last use). On exceed, throw `RateLimitExceededError`. Configurable per namespace via `maxStoresPerRun`.
- [ ] 4.4 SSE event emission: `memory.stored`, `memory.retrieved`, `memory.pruned`, `memory.error` for each operation.
- [ ] 4.5 Singleton accessor `getMemoryService()` matching `getSessionPool()` / `getDedupRedis()` pattern. Lazy init on first call; constructed from `getSettings()`.
- [ ] 4.6 Tests: store happy path, search happy path with topK / minSimilarity, delete happy path, prune happy path, rate-limit-exceeded raises, unknown namespace raises, embedding failure raises. All against fake providers + InMemoryVectorStore.

## 5. HTTP endpoints

- [ ] 5.1 `src/routes/memory.routes.ts` mounting `/api/memory/store` (POST), `/api/memory/search` (POST), `/api/memory/:id` (DELETE).
- [ ] 5.2 `src/controllers/memory.controller.ts` with three handlers. Each: bearer-token validation (`CLAWNDOM_AGENT_TOKEN`), Zod-parsed input, MemoryService call, structured response. Map service errors to HTTP codes: `UnknownNamespaceError` → 400, `RateLimitExceededError` → 429, generic → 500.
- [ ] 5.3 Wire routes into `src/server.ts` after the existing `/api/tasks` routes.
- [ ] 5.4 Tests against supertest: each endpoint's happy path, auth failure (401), invalid input (400), unknown namespace (400), rate-limit (429). Mock MemoryService.

## 6. Worker pre-render hook + template engine

- [ ] 6.1 In `src/services/worker.service.ts`: when `resolved.rule.memory?.retrieve` is set, resolve `queryField` against the parsed payload. If non-string or undefined, skip. Otherwise call `memoryService.search()` and capture results.
- [ ] 6.2 Pass results to the template renderer via a new `memories` parameter on `renderTemplate()`. Template engine extension: `{{ memories }}` interpolates to a formatted block (`- text [score: 0.85]\n- ...`) when results present, or empty string when absent.
- [ ] 6.3 Tests: rule with retrieve calls memoryService.search and injects {{ memories }}, rule without retrieve does not call search and renders empty, missing query field does not call search.

## 7. agency-tools Python module

- [ ] 7.1 In `agency-tools` repo: `agency_tools/memory/__init__.py` (re-exports `MemoryError`), `agency_tools/memory/_http.py` (Bearer auth helper, raises `MemoryError` on non-2xx), `agency_tools/memory/store.py`, `agency_tools/memory/search.py`, `agency_tools/memory/delete.py`. Same shape as `agency_tools.slack`.
- [ ] 7.2 README + CHANGELOG entry; bump pyproject `version` to `1.2.0`.
- [ ] 7.3 Per-function tests using `mock_req` and `fake_urlopen` fixtures (already present in `tests/conftest.py`): happy / 4xx / 5xx / network-error paths.
- [ ] 7.4 Tag `v1.2.0` after merge.

## 8. Pruning scheduler

- [ ] 8.1 `src/services/memory/pruning.service.ts`: starts a `setInterval` (24-hour cadence) on Clawndom boot. On each tick, walk all registered namespaces, call `memoryService.prune({namespace})`, log + emit `memory.pruned`.
- [ ] 8.2 First-tick offset: schedule first prune ~10 seconds after startup so a fresh deploy gets a baseline run.
- [ ] 8.3 Graceful shutdown: clear the interval on `SIGTERM`. Test via fake timers.
- [ ] 8.4 Tests: scheduler fires prune for each namespace at the configured cadence; survives a single-namespace failure (one namespace's prune throwing doesn't block others).

## 9. Observability event types

- [ ] 9.1 Add `MemoryStoredEvent`, `MemoryRetrievedEvent`, `MemoryPrunedEvent`, `MemoryErrorEvent` to `src/types/clawndom-event.ts`. Wire into the union.
- [ ] 9.2 Tests: each event publishes with the right shape from MemoryService operations.

## 10. Standalone integration test (no Winston)

- [ ] 10.1 Stand up a Redis instance via `docker compose up redis-stack` (RediSearch enabled) — already in `infra/dev-stack.yml` per project convention; if not, add it.
- [ ] 10.2 Write a `tests/integration/memory.integration.test.ts` (excluded from default `vitest run` via tag, runnable as `pnpm test:integration`):
   - Boot a real Clawndom against the docker Redis
   - Use the real OpenAI embedding provider (CI skips this test if `OPENAI_API_KEY` is unset)
   - Store 10 facts in a `test-ns` namespace
   - Search for a synonym of one of them; assert it surfaces in top-3
   - Delete one entry, assert search no longer returns it
   - Manually backdate `last_accessed_at` on one entry; trigger prune; assert deletion
- [ ] 10.3 Document the integration-test invocation in `docs/development.md`.

## 11. Winston integration

- [ ] 11.1 In winston-agency `clawndom.yaml`: add top-level `memory.namespaces.winston-personal` with `embeddingProvider: openai`, `vectorStore: redis`, `pruneAfter: 365d`. Add `memory:` block to the `slack-winston.rules[0].chat` rule with `namespace: winston-personal`, `retrieve.queryField: event.text`, `topK: 5`, `minSimilarity: 0.7`.
- [ ] 11.2 Update `templates/slack-chat.md`:
   - Add `## Step 0 — Read your memories about this person` section showing `{{ memories }}` and instructions to consult before composing.
   - Add `## Step 5.5 — Store new durable facts` section with a rate-limited store call pattern: only durable facts (preferences, identifiers, ongoing context), not one-off mood or pleasantries.
   - Provide explicit examples of WHAT to store ("Chris has a cat named Porter") vs WHAT NOT to store ("Chris said good morning").
- [ ] 11.3 Plumb `OPENAI_API_KEY` secret on Winston's EC2: 1Password vault entry, add to `SECRETS_CONFIG` in `clawndom.env`.
- [ ] 11.4 Smoke test: send Winston a DM with a durable fact ("my favorite color is blue"); verify `memory.stored` event fires; verify Redis has the entry. Then send a fresh DM in another channel asking the recall question; verify retrieval surfaces it and Winston answers correctly.

## 12. Validation and rollout

- [ ] 12.1 `make check-all` green (lint, typecheck, prettier, full test suite incl. memory unit tests, coverage gates green — exclude memory.service from coverage if needed, same convention as session-pool/worker).
- [ ] 12.2 Update `clawndom/openspec/specs/agent-runner-strategy/spec.md` to cross-reference the new `memory-aware-agent-runner` capability if appropriate (or leave as a separate capability that opts in).
- [ ] 12.3 Document the operator runbook for memory: how to inspect entries (`redis-cli FT.SEARCH memory-winston-personal '*' RETURN 1 text`), how to delete a specific bad memory (`DELETE /api/memory/{id}`), how to flush a namespace (`redis-cli FT.DROPINDEX memory-winston-personal DD`).
- [ ] 12.4 PR up; review; merge to main; deploy.
