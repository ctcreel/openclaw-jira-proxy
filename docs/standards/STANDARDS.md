# Engineering Standards

## Code Quality

- **TypeScript strict mode** — No implicit any, no unchecked index access
- **ESLint + Prettier** — Consistent formatting and lint rules
- **95% test coverage** — Vitest with coverage thresholds (statements, branches, functions, lines)
- **Security scanning** — Gitleaks for secrets, pnpm audit for dependencies

## Enforcement Tools

| Tool | What it checks | Where it runs |
|------|---------------|---------------|
| ESLint | Code quality, security rules | Pre-commit, CI |
| Prettier | Formatting | Pre-commit, CI |
| TypeScript | Type safety | Pre-commit, CI |
| Vitest | Tests + coverage | CI |
| Gitleaks | Secret detection | Pre-commit, CI |
| pnpm audit | Dependency vulnerabilities | CI |
| Custom scripts | Naming, abbreviations, skip comments | Pre-commit, CI |

## Principles

1. **Fail fast** — No defensive code, no silent fallbacks
2. **Validate at boundaries** — Zod for external input (HTTP, env vars), trust internal code
3. **No skip comments** — Fix the issue, don't suppress the warning (`@ts-ignore`, `eslint-disable` forbidden)
4. **No `any` type** — Use `unknown` and narrow with type guards
5. **No type assertions** — Fix types instead of casting with `as`
6. **Files under 300 lines** — If a file crosses 300, ask if it's doing too much
7. **Functions under 50 lines** — Extract when complexity warrants it
8. **Always release resources** — Semaphore slots, WebSocket connections, Redis clients in `finally` blocks
