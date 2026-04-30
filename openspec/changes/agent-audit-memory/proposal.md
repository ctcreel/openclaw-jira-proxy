## Why

When debugging agent behavior — "why didn't Winston draft a reply for the Culotta email?" — the only option today is grepping `/var/log/clawndom-winston/clawndom.log` for the message ID or a keyword. The log is a flat JSON file that grows indefinitely, truncates assistant text to 200 chars, and is keyword-searchable only. Asking "what did Winston decide about rental inquiries?" requires knowing the exact word "rental" appeared in the output.

The memory subsystem (agent-memory change) already provides semantically-searchable, TTL-pruned, vector-indexed storage. Agent reasoning — the `runner.assistant_text` stream that explains every triage decision, every draft skip, every label application — is exactly the kind of content that benefits from semantic retrieval. "Why did Winston skip the draft for the commercial real estate email?" should return the relevant reasoning even if the query doesn't share keywords with the stored text.

## What Changes

- **NEW**: Optional `audit` block in the agent's `memory` config:
  ```yaml
  memory:
    namespaces:
      winston-audit:
        embeddingProvider: openai
        vectorStore: redis
        pruneAfter: 90d
        maxStoresPerRun: 1    # one summary per job, not per text chunk
    audit:
      namespace: winston-audit
      providers:              # which providers' runs to audit
        - gmail-heather
        - gmail-winston
  ```
  Agents without an `audit` block get no behavior change.

- **MODIFIED**: Worker (`src/services/worker.service.ts`) accumulates `runner.assistant_text` chunks during a run. On `job.completed`, if the matched agent has `audit` config and the provider is in the audit list, the worker stores a concatenated summary of the assistant's reasoning in the audit namespace via `MemoryService.store()`.

- **NEW**: `memory.audit_stored` SSE event for observability.

- **No template changes.** Audit storage is infrastructure — the agent doesn't need to know about it or opt in per-run. The worker handles it automatically.

## What Doesn't Change

- Template rendering pipeline — unchanged.
- Existing `memory.retrieve` / `memory.store` flow — unchanged. Audit is a separate namespace; it doesn't interfere with conversational memory.
- Agent prompt — no audit fragments injected. This is write-only storage for operator queries, not agent self-awareness.
- Log file — still written as before. Audit memory supplements, doesn't replace.

## Capabilities

### New Capabilities

| Capability | Spec |
|---|---|
| `audit-memory` | `openspec/specs/observability/audit-memory.md` |

### Modified Capabilities

None.

## Scope

- **In scope**: Worker-side text accumulation, post-job store call, config schema, SSE event, tests.
- **Out of scope**: Querying audit memory from templates (agents reading their own audit trail). Retention policy UI. Cross-agent audit queries. Filtering/summarization of assistant text before storage (store the full concatenated output for now; summarization is a future optimization if storage costs matter).
