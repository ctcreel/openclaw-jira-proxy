# Branching Strategy

## Four-Branch Model

```
development -> testing -> demo -> production
```

| Branch | Environment | Purpose |
|--------|-------------|---------|
| `development` | Dev | Integration branch |
| `testing` | QA | Quality assurance |
| `demo` | Demo | Stakeholder review |
| `production` | Prod | Live environment |

## Feature Branch Naming

Format: `{type}/{TICKET-ID}-{description}`

| Type | Use for |
|------|---------|
| `feature` | New features |
| `bugfix` | Bug fixes |
| `hotfix` | Urgent fixes |
| `chore` | Maintenance |
| `docs` | Documentation |
| `refactor` | Code refactoring |
| `test` | Test additions |

Rules:
- Ticket ID: `{PROJECT}-{NUMBER}` (e.g., `SF-123`)
- Description: lowercase, numbers, hyphens only, 3-50 chars
- Example: `feature/SF-123-add-user-authentication`

## Workflow

1. Create feature branch from `development`
2. Work, commit, push
3. Create PR to `development`
4. Pass all checks + CodeRabbit review
5. Merge to `development`
6. Promote: development -> testing -> demo -> production (via PRs)
