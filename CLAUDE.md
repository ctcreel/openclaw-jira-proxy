# clawndom — TypeScript Backend Standards

## Before Completing Any Task

```bash
make check-all   # ALL checks must pass before commit
```

After pushing, check CodeRabbit: `gh pr view --comments`

## Architecture

Express.js standalone proxy. BullMQ + Redis for job queue. WebSocket to OpenClaw gateway for `agent.wait` RPC.

```
src/routes/       - HTTP route definitions
src/controllers/  - Request handling, input validation, HMAC signature verification
src/services/     - Business logic (queue, worker, gateway client, concurrency gate)
src/lib/          - Shared infrastructure (logging, exceptions, utils)
src/middleware/    - Express middleware (error handler, request logger, validation)
src/strategies/   - Signature validation strategies (websub, github)
```

Dependencies flow inward: routes -> controllers -> services -> lib.

Multi-provider: each webhook provider (Jira, GitHub, etc.) gets its own route, HMAC strategy, and BullMQ queue. Workers wait for `agent.wait` completion before picking up the next job.

## Rules

- **Fail fast** -- no defensive code, no silent fallbacks
- **Validate at boundaries only** -- Zod in controllers, trust internally
- **No `any`** -- use `unknown` and narrow
- **No `as` casting** -- fix the types
- **No skip comments** -- `@ts-ignore`, `eslint-disable`, etc. are forbidden
- Functions start with a verb: get, create, update, delete, build, process, handle, validate
- No abbreviations: use `message` not `msg`, `request` not `req`, `response` not `res`
- Files under 300 lines, functions under 50 lines
- 95%+ test coverage

## Patterns

| Pattern | Location |
|---------|----------|
| Error Hierarchy | `src/lib/exceptions/` |
| Retry + Backoff | `src/lib/utils/retry.ts` |
| TTL Cache | `src/lib/utils/cache.ts` |
| Structured Logging | `src/lib/logging/` |
| Zod Validation | `src/middleware/validate.ts` |
| Request Context | `src/lib/logging/context.ts` |

## Commands

```bash
make dev          # Local server with hot reload
make check        # Lint + test + security + naming
make check-all    # Full validation (required before commit)
make format       # Auto-fix formatting
```

See `docs/` for detailed guides.
