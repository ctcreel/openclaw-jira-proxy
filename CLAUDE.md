# Sc0red TypeScript Backend Standards

## Before Completing Any Task

```bash
make check-all   # ALL checks must pass before commit
```

After pushing, check CodeRabbit: `gh pr view --comments`

## Architecture

Express.js on AWS Lambda via @vendia/serverless-express. MongoDB/Mongoose for data.

```
src/routes/       - HTTP route definitions
src/controllers/  - Request handling, input validation
src/services/     - Business logic
src/lib/          - Shared infrastructure (logging, exceptions, utils)
src/database/     - Mongoose connection and models
src/middleware/    - Express middleware (error handler, request logger, validation)
```

Dependencies flow inward: routes -> controllers -> services -> lib/database.

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
