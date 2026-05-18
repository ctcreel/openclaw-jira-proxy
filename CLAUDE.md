# clawndom — TypeScript Backend Standards

## Before Completing Any Task

```bash
make check-all   # ALL checks must pass before commit
```

After pushing, check CodeRabbit: `gh pr view --comments`

## Architecture

> **Start here on a fresh session:** read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). It is the load-bearing mental model — the three-repo split (clawndom / agent-workspaces / agency-tools), the job lifecycle, and where to look for any debug entry point. Five minutes there saves an hour of wrong assumptions.

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

- **Tool surface = route's `tools:` block.** An agent's capabilities are exactly the union of its routes' `tools:` declarations. Templates do NOT enumerate or grant tools. `agency-tools` is a capability *menu*; adding a tool there grants zero agents access until a route opts in. When debugging "why can't the agent do X?", look at the route's `tools:` — there is no other source.
- **Live agent-workspace HEAD may be ahead of your local checkout.** Builder PRs (and live edits on the host) advance the deployed workspace autonomously. Before reasoning about deployed behavior, check `/home/ubuntu/.clawndom-<agent>/agents/<owner>__<repo>/` HEAD on the host, not your working copy.
- **Tail the log file, not journalctl.** Each clawndom service has `StandardOutput=append:/var/log/clawndom-<agent>/clawndom.log`; journalctl shows only systemd lifecycle events, not node stdout.
- **Fail fast** -- no defensive code, no silent fallbacks
- **Validate at boundaries only** -- Zod in controllers, trust internally
- **No `any`** -- use `unknown` and narrow
- **No `as` casting** -- fix the types
- **No skip comments** -- `@ts-ignore`, `eslint-disable`, etc. are forbidden
- Functions start with a verb: get, create, update, delete, build, process, handle, validate
- No abbreviations: use `message` not `msg`, `request` not `req`, `response` not `res`
- Files under 300 lines, functions under 50 lines
- Test coverage gate enforced in `vitest.config.ts` (current floor: 95% statements/lines/functions, 88% branches — branch ceiling is bounded by documented-unreachable `noUncheckedIndexedAccess` narrows; see config comment)

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
| Agent Tool Use (SPE-2078) | `src/services/tools/` — route-side `tools:` declaration, credential-agent pattern via MCP, per-call audit log. See `docs/guides/TOOLS_AND_TOOL_USE.md`. |
| Agent Versioning | `src/services/version.service.ts` + `src/lib/version/` — deterministic sha256 over involved repos, served at `GET /api/version`, embedded in every audit record. |

## Commands

```bash
make dev          # Local server with hot reload
make check        # Lint + test + security + naming
make check-all    # Full validation (required before commit)
make format       # Auto-fix formatting
make preview-template TEMPLATE=<path> PAYLOAD=<path>  # Preview rendered template
```

See `docs/` for detailed guides.
