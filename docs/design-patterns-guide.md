# Design Patterns Guide

## Patterns Used in This Template

| Pattern | Location | Purpose |
|---------|----------|---------|
| Template Method | `src/lib/exceptions/base.ts` | Base exception defines structure, subclasses customize |
| Registry | `src/lib/exceptions/base.ts` | Auto-registration of exceptions by error code |
| Decorator | `src/lib/utils/retry.ts` | Retry logic wraps functions transparently |
| Strategy | `src/lib/utils/retry.ts` | Configurable backoff via RetryConfig |
| Factory | `src/lib/logging/logger.ts` | `getLogger()` creates configured loggers |
| Singleton State | `src/lib/logging/logger.ts` | Module-level state for one-time setup |
| Adapter | `src/lib/logging/adapters/` | Lambda/Express adapters for different runtimes |
| TTL Cache | `src/lib/utils/cache.ts` | Time-based caching with eviction |

Use these patterns when appropriate. Don't invent new patterns unnecessarily.
