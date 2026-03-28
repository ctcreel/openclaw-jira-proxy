# Branching Strategy

## Single-Branch Model

clawndom uses `main` as the primary branch. This is a standalone infrastructure service, not a multi-environment application — there is no promotion pipeline through testing/demo/production.

## Feature Branch Naming

Format: `{type}/{description}`

| Type | Use for |
|------|---------|
| `feature` | New features (e.g., new provider support) |
| `fix` | Bug fixes |
| `chore` | Maintenance, dependency updates |
| `docs` | Documentation changes |
| `refactor` | Code restructuring |

Rules:
- Description: lowercase, numbers, hyphens only
- Example: `feature/github-provider`, `fix/websocket-reconnect`

## Workflow

1. Create feature branch from `main`
2. Work, commit, push
3. Create PR to `main`
4. Pass all checks (lint, test, typecheck, security)
5. Merge to `main`
