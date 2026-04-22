# clawndom — TypeScript Backend Standards

## Before Completing Any Task

```bash
make check-all   # ALL checks must pass before commit
```

After pushing, check CodeRabbit: `gh pr view --comments`

## Architecture

Express.js standalone proxy. BullMQ + Redis for job queue. Pluggable runner backends for prompt delivery.

```
src/routes/       - HTTP route definitions
src/controllers/  - Request handling, input validation, HMAC signature verification
src/services/     - Business logic (queue, worker, gateway client, concurrency gate)
src/runners/      - Agent runner abstraction (openclaw, claude-cli, openai, bedrock, null)
src/lib/          - Shared infrastructure (logging, exceptions, utils)
src/middleware/    - Express middleware (error handler, request logger, validation)
src/strategies/   - Signature validation strategies (websub, github, bearer, slack)
```

Dependencies flow inward: routes -> controllers -> services -> lib. Runners are infrastructure adapters — services depend on the `AgentRunner` interface, never on concrete implementations.

Multi-provider: each webhook provider (Jira, GitHub, etc.) gets its own route, HMAC strategy, and BullMQ queue. Each provider may specify a runner type (`openclaw`, `claude-cli`, `openai`, `bedrock`). Workers wait for `runner.run()` completion before picking up the next job.

## Rules

- **Fail fast** -- no defensive code, no silent fallbacks
- **Validate at boundaries only** -- Zod in controllers, trust internally
- **No `any`** -- use `unknown` and narrow
- **No `as` casting** -- fix the types
- **No skip comments** -- `@ts-ignore`, `eslint-disable`, etc. are forbidden
- Functions start with a verb: get, create, update, delete, build, process, handle, validate
- No abbreviations: use `message` not `msg`, `request` not `req`, `response` not `res`
- Files under 300 lines, functions under 50 lines
- Test coverage gate enforced in `vitest.config.ts` (current floor: 87% lines/statements, 88% branches, 93% functions — raise as missing specs land)

## Patterns

| Pattern | Location |
|---------|----------|
| Error Hierarchy | `src/lib/exceptions/` |
| Retry + Backoff | `src/lib/utils/retry.ts` |
| TTL Cache | `src/lib/utils/cache.ts` |
| Structured Logging | `src/lib/logging/` |
| Zod Validation | `src/middleware/validate.ts` |
| Request Context | `src/lib/logging/context.ts` |
| Agent Runners | `src/runners/` (strategy pattern) |
| Secrets Management | `src/secrets/` (strategy pattern — env, 1password, oauth, file providers) |
| Prompt Observability | `src/services/worker.service.ts` (hash at info, full at debug) |

## Commands

```bash
make dev          # Local server with hot reload
make check        # Lint + test + security + naming
make check-all    # Full validation (required before commit)
make format       # Auto-fix formatting
make preview-template TEMPLATE=<path> PAYLOAD=<path>  # Preview rendered template
```

See `docs/` for detailed guides.
