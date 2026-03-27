# Naming Conventions

## TypeScript

| Element | Convention | Example |
|---------|------------|---------|
| Classes | PascalCase | `RetryConfig`, `Sc0redError` |
| Interfaces | PascalCase | `HealthResponse`, `CacheStats` |
| Types | PascalCase | `LogLevel`, `MetricUnit` |
| Enums | PascalCase | `HealthStatus` |
| Functions | camelCase with verb | `createRetryDecorator`, `getLogger` |
| Methods | camelCase | `calculateDelay`, `toDict` |
| Constants | SCREAMING_SNAKE | `DEFAULT_CONFIG`, `MAX_RETRIES` |
| Variables | camelCase | `errorMessage`, `retryCount` |
| Files | kebab-case | `retry-config.ts`, `health-check.ts` |

## Functions Must Start with a Verb

Common verbs: get, set, create, update, delete, build, process, handle, validate, render, fetch, parse, format, transform, calculate, compute, generate, initialize, setup, cleanup, start, stop, open, close, connect, disconnect, enable, disable, search, find, filter, sort, merge, register, publish, download, upload, sync.

Boolean functions: `is`, `has`, `can`, `should`, `will`, `was`, `are`, `have`.

## Forbidden Abbreviations

Use full words:
- `message` not `msg`
- `request` not `req`
- `response` not `res`
- `config` not `cfg`
- `context` not `ctx`
- `database` not `db`
- `connection` not `conn`
- `environment` not `env`
- `temporary` not `tmp`/`temp`
- `button` not `btn`
- `error` not `err`

## AWS Resources

- Stack names: `{Service}-{Environment}-{Resource}` (PascalCase)
- Lambda functions: `{service}-{environment}-{function}` (kebab-case)
- S3 buckets: `{org}-{service}-{environment}-{purpose}` (kebab-case)
