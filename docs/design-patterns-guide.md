# Design Patterns Guide

## Patterns Used in clawndom

| Pattern | Location | Purpose |
|---------|----------|---------|
| Strategy | `src/strategies/signature/` | Signature validation per provider (WebSub, GitHub, Slack, Bearer) |
| Strategy | `src/strategies/transport/` | Inbound transport (webhook, slack-socket) |
| Strategy | `src/strategies/session-key/` | Per-rule session-key derivation (slack-thread, etc.) |
| Strategy | `src/strategies/context.ts` | Per-provider webhook payload context extraction (Jira, GitHub, Slack) |
| Strategy | `src/runners/` | Agent runner per route (claude-cli, openai, bedrock, null) |
| Strategy | `src/secrets/` providers | Secret resolution per backend (env, 1password, oauth, file) |
| Strategy | `src/services/memory/embedding/` | Embedding provider (openai, null-fake) |
| Strategy | `src/services/memory/vector-store/` | Vector store (redis, in-memory) |
| Strategy | `src/services/tools/` | Tool dispatch via MCP bridge → Python `impl.py` subprocess |
| Registry | `src/providers/registry.ts` | Provider lookup by route path |
| Registry | `src/secrets/registry.ts` | Secret-provider lookup by type |
| Registry | `src/services/memory/{embedding,vector-store}/index.ts` | Embedding + vector-store lookup |
| Registry | `src/strategies/{signature,transport,session-key}/index.ts` | Strategy registries |
| Registry | `src/lib/exceptions/base.ts` | Exception class lookup by error code |
| Discriminated Union | `src/services/tools/config-schemas.ts` | `module.<lang>:` key as runtime kind discriminant |
| Template Method | `src/lib/exceptions/base.ts` | Base exception defines structure, subclasses customize |
| Decorator | `src/lib/utils/retry.ts` | Retry logic wraps functions transparently |
| Factory | `src/lib/logging/logger.ts` | `getLogger()` creates configured loggers |
| Singleton State | `src/services/queue.service.ts` | Lazy queue creation, cached per provider |
| Singleton State | `src/services/gateway.service.ts` | Single shared WebSocket connection |
| Singleton State | `src/secrets/manager.ts` | One SecretManager per process; resolved values held in closure |
| Singleton State | `src/services/version.service.ts` | One agent_version computed at boot, served from cache |
| TTL Cache | `src/lib/utils/cache.ts` | Time-based caching with eviction |
| TTL Cache | `src/secrets/cache.ts` | File-backed secrets cache (tmpfs, mode 0600, UID-checked) |
| Semaphore | `src/services/concurrency.service.ts` | Redis-backed global concurrency gate |
| Object Pool | `src/services/session-pool.service.ts` | Warm claude-cli subprocesses, Redis-backed session_id resume |
| Bridge | `src/services/tools/mcp-bridge.ts` | TS executor ↔ Python MCP server via stdio JSON-RPC + config files |

## When to Use Each

- **Strategy** — When behavior varies by type but the interface is identical. Every strategy registry in this codebase follows the same shape: an interface declaring a `name` field and one or more methods, a registry that maps names to instances, and a lookup function that throws on unknown name. Signature validation is the canonical example: every provider needs `validate(body, header, secret) → boolean`, but the header name and format differ.
- **Registry** — When you need runtime lookup by key. Provider registry maps route paths to their config + strategy. Exception registry maps error codes to classes. Strategy registries map provider/transport/runner names to implementations.
- **Discriminated Union** — When a value can be one of several shapes and the discrimination is structural (a present key), not a separate `kind` field. The tool reference schema in `src/services/tools/config-schemas.ts` uses this for `module.python:` (today; extensible to `module.rust:`, etc.). Zod's `.strict()` on each variant rejects mixed-key objects automatically.
- **Semaphore** — When you need to limit concurrent access to a shared resource. The global concurrency gate prevents multiple providers from overwhelming the LLM API simultaneously.
- **Decorator** — When you want to add behavior (retry, logging, timing) without modifying the original function.
- **Factory** — When construction is non-trivial or needs configuration. Logger creation, queue creation.
- **Object Pool** — When subprocess startup cost dominates per-event cost AND a session_id can resume conversation state. The SessionPool warms `claude-cli` subprocesses and routes sessioned events to the right one via Redis-backed session_id lookup.
- **Bridge** — When two address spaces need to cooperate. The MCP bridge marshals tool descriptors + resolved credentials into a config file + env handoff so the Python MCP server can dispatch tool calls without sharing memory with the TS process.

## Why these aren't shared

Some surface-level duplication is intentional and documented in source comments:

- **Three `_http.py` helpers** (`agency-tools/agency_tools/{slack,google,memory}/_http.py`) — each has a different error model (Slack: 200 + `ok:false`; Google: HTTPError propagates; Memory: HTTPError → MemoryAPIError). The contract differs; consolidating would force a lowest-common-denominator that fits none cleanly.
- **TS `redactCredentials` and Python `_redact_credentials`** in clawndom — different process address spaces. Code is duplicated; the contract is identical and tested on both sides.
- **`extract_body` originally duplicated in `gmail.get_message` and `gmail.get_thread`** — collapsed to `_extract_plain_text_body` in the SPE-2078 followups. Not shared = drift candidate.

## Anti-Patterns to Avoid

- **God service** — If a service file exceeds 300 lines, it's doing too much. Split by responsibility.
- **Strategy without interface** — Every strategy must implement the same typed interface. No duck typing.
- **Semaphore without cleanup** — Always release in a `finally` block. Leaked slots deadlock the system.
- **Inline-duplicated helper inside two functions** — If you find yourself defining the same `def inner_helper(...)` inside two outer functions, extract it to module scope. The DRY violation will silently drift.
- **`kind` field next to a discriminated union** — If the schema already uses key presence to discriminate (e.g. `module.python:` vs `module.bash:`), don't also add `kind: 'python'`. The redundant field can lie when the union mutates.
- **`try: ... except Exception: return default`** — too-broad swallowing hides corruption. Narrow to the specific exception types that mean "treat as missing" (e.g. `FileNotFoundError`); log everything else. See `winston-agency/workspaces/winston/tools/gmail_push_server.py → load_state` for the pattern.
- **Hand-rolled base64 padding (`data + '=='`)** — relies on `urlsafe_b64decode`'s tolerance. Compute exact padding: `pad = (-len(data)) % 4; data + ('=' * pad)`. See `agency_tools/google/gmail.py → _decode_urlsafe_b64`.
- **Defensive narrowing tests** — When `noUncheckedIndexedAccess` forces an `if (x === undefined) throw 'unreachable'` branch, testing that branch is theater. Document the unreachable branch and accept the branch-coverage delta rather than writing fake tests.
