# Naming Conventions

## TypeScript

| Element | Convention | Example |
|---------|------------|---------|
| Classes | PascalCase | `WebSubStrategy`, `ConcurrencyGate` |
| Interfaces | PascalCase | `ProviderConfig`, `SignatureStrategy`, `HealthResponse` |
| Types | PascalCase | `TerminalStatus`, `ProviderName` |
| Functions | camelCase with verb | `validateSignature`, `getProviderQueue`, `acquireSlot` |
| Methods | camelCase | `calculateDelay`, `processJob` |
| Constants | SCREAMING_SNAKE | `DEFAULT_TIMEOUT_MS`, `MAX_RETRIES` |
| Variables | camelCase | `runId`, `signatureHeader`, `hmacSecret` |
| Files | kebab-case | `queue.service.ts`, `websub.strategy.ts` |

## Functions Must Start with a Verb

Common verbs: get, set, create, update, delete, build, process, handle, validate, acquire, release, connect, disconnect, forward, dispatch, enqueue.

Boolean functions: `is`, `has`, `can`, `should`.

## Forbidden Abbreviations

Use full words:

- `message` not `msg`
- `request` not `req`
- `response` not `res`
- `config` not `cfg`
- `context` not `ctx`
- `connection` not `conn`
- `environment` not `env`
- `temporary` not `tmp`/`temp`
- `error` not `err`
- `signature` not `sig`

## File Organization

| Directory | Naming Pattern | Example |
|-----------|---------------|---------|
| `src/controllers/` | `<noun>.controller.ts` | `webhook.controller.ts` |
| `src/services/` | `<noun>.service.ts` | `queue.service.ts`, `worker.service.ts` |
| `src/strategies/` | `<name>.strategy.ts` | `websub.strategy.ts`, `github.strategy.ts` |
| `src/middleware/` | `<noun>.ts` | `error-handler.ts`, `validate.ts` |
| `src/lib/` | descriptive kebab-case | `exceptions/base.ts`, `utils/retry.ts` |
