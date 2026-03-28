# Design Patterns Guide

## Patterns Used in clawndom

| Pattern | Location | Purpose |
|---------|----------|---------|
| Strategy | `src/strategies/` | Signature validation per provider (WebSub, GitHub) |
| Registry | `src/providers/registry.ts` | Provider registration and lookup by route path |
| Template Method | `src/lib/exceptions/base.ts` | Base exception defines structure, subclasses customize |
| Registry | `src/lib/exceptions/base.ts` | Auto-registration of exceptions by error code |
| Decorator | `src/lib/utils/retry.ts` | Retry logic wraps functions transparently |
| Factory | `src/lib/logging/logger.ts` | `getLogger()` creates configured loggers |
| Singleton State | `src/services/queue.service.ts` | Lazy queue creation, cached per provider |
| Singleton State | `src/services/gateway.service.ts` | Single shared WebSocket connection |
| TTL Cache | `src/lib/utils/cache.ts` | Time-based caching with eviction |
| Semaphore | `src/services/concurrency.service.ts` | Redis-backed global concurrency gate |

## When to Use Each

- **Strategy** — When behavior varies by type but the interface is identical. Signature validation is the canonical example: every provider needs `validate(body, header, secret) → boolean`, but the header name and format differ.
- **Registry** — When you need runtime lookup by key. Provider registry maps route paths to their config + strategy. Exception registry maps error codes to classes.
- **Semaphore** — When you need to limit concurrent access to a shared resource. The global concurrency gate prevents multiple providers from overwhelming the LLM API simultaneously.
- **Decorator** — When you want to add behavior (retry, logging, timing) without modifying the original function.
- **Factory** — When construction is non-trivial or needs configuration. Logger creation, queue creation.

## Anti-Patterns to Avoid

- **God service** — If a service file exceeds 300 lines, it's doing too much. Split by responsibility.
- **Strategy without interface** — Every strategy must implement the same typed interface. No duck typing.
- **Semaphore without cleanup** — Always release in a `finally` block. Leaked slots deadlock the system.
