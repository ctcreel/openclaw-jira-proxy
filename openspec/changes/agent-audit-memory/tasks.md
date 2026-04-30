## 1. Config schema

- [ ] 1.1 Add `auditConfigSchema` to `src/services/memory/config-schemas.ts`: `{ namespace: string, providers: string[] }`. Namespace is required, providers defaults to `["*"]` (all).
- [ ] 1.2 Add optional `audit` field to the agent-level memory config in `src/services/agent-loader.service.ts`. Validate that `audit.namespace` references a declared namespace (reuse the same validation pattern as `rule.memory.namespace`).
- [ ] 1.3 Expose resolved audit config on `ResolvedAgent` so the worker can access it: `agent.config.memory?.audit`.
- [ ] 1.4 Tests: audit config accepted, missing namespace rejected, empty providers defaults to `["*"]`, agent without audit block is unchanged.

## 2. Worker text accumulation

- [ ] 2.1 In `processJob()` (`src/services/worker.service.ts`), declare `assistantTextChunks: string[]` before the runner dispatch.
- [ ] 2.2 Subscribe to `runner.assistant_text` events from the event bus, filtered by `event.jobId === jobIdString`. Push `event.text` to the chunks array.
- [ ] 2.3 Unsubscribe after the runner completes (in the `finally` block, before the `job.completed` event is published).
- [ ] 2.4 Tests: chunks accumulated correctly across multiple text events; unsubscribe prevents leaks; empty runs produce empty array.

## 3. Post-completion audit store

- [ ] 3.1 After `job.completed` event is published, check if the matched agent has `audit` config and the current provider is in the audit providers list (or providers is `["*"]`).
- [ ] 3.2 If audit applies: concatenate chunks with `\n\n`, cap at 8000 chars (append `\n[truncated]` if capped), call `memoryService.store()` with:
  - `namespace`: from audit config
  - `text`: concatenated assistant output
  - `metadata`: `{ source, jobId, traceId, agentId, provider, template, recordedAt }`
  - `traceId`: `audit-${traceId}` (separate rate-limit budget)
- [ ] 3.3 Wrap the store call in try/catch — audit storage failure must not fail the job. Log the error at `warn` level and continue.
- [ ] 3.4 Publish `memory.audit_stored` SSE event on success with `{ namespace, jobId, traceId, provider, textLength }`.
- [ ] 3.5 Tests: audit store called on matching provider; skipped on non-matching provider; skipped when agent has no audit config; failure logged but job still succeeds; text capped at 8000 chars; SSE event emitted.

## 4. Event type

- [ ] 4.1 Add `memory.audit_stored` to `src/types/clawndom-event.ts` event union.
- [ ] 4.2 Tests: event schema validates.

## 5. Integration test

- [ ] 5.1 End-to-end test: configure an agent with audit enabled for a test provider, dispatch a webhook job, verify a memory entry is stored in the audit namespace with the expected metadata and text content. Use `InMemoryVectorStore` + `NullEmbeddingProvider`.
- [ ] 5.2 Search the audit namespace with a semantic query and verify the stored entry is returned.
