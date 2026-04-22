## Purpose

Defines the automated enforcement mechanisms that prevent quality violations from reaching the codebase. Enforcement operates at three layers: local (pre-commit), CI (pull request), and review (CodeRabbit + SonarCloud).

## Requirements

### Requirement: Pre-Commit Hooks

The template MUST run the following checks before every commit via git hooks:
- Linter on staged files
- Formatter check on staged files
- Type checker (full project)
- Trailing whitespace removal
- End-of-file newline enforcement
- YAML and JSON validation
- Merge conflict marker detection
- Large file detection (>1000kb threshold)
- Private key detection
- Conventional Commits message validation
- No-commit-to-branch guard (direct commits to `main` must fail)

#### Scenario: Commit With Type Error
- **GIVEN** A developer stages a file with a type error
- **WHEN** They attempt to commit
- **THEN** The pre-commit hook MUST block the commit and report the type error

### Requirement: Pre-Push Hooks

The repository MUST validate branch naming on every push. Branch names MUST follow the format: `{type}/{TICKET-ID}-{description}` where type is one of: feature, bugfix, hotfix, chore, docs, refactor, test.

`main` is the sole long-lived branch and MUST be allowed without validation.

#### Scenario: Invalid Branch Name
- **GIVEN** A developer is on branch `my-feature`
- **WHEN** They attempt to push
- **THEN** The pre-push hook MUST block the push and show the required format

### Requirement: Claude Code Hooks

The template MUST include Claude Code hooks that mechanically enforce:
1. **Pre-commit gate** — Blocks `git commit` unless `make check-all` is chained before it. MUST also require bot identity and Conventional Commits format.
2. **Post-push review** — After `git push`, MUST block until the developer checks CodeRabbit review comments.

#### Scenario: AI Attempts Commit Without Full Check
- **GIVEN** Claude Code attempts to run `git commit -m "feat: add feature"`
- **WHEN** The pre-commit gate hook evaluates the command
- **THEN** The hook MUST block with exit code 2 and instruct to chain `make check-all`

### Requirement: CI Pipeline Checks

The repository MUST run these checks on every pull request via GitHub Actions:
- Lint (linter + type checker + formatter check)
- Test (with coverage threshold enforcement, Redis service container)
- Security (dependency audit)
- Naming validation (branch name + naming conventions + abbreviations + skip comments)
- SonarCloud analysis (via the SonarCloud GitHub App)

All checks MUST pass before merge is allowed.

#### Scenario: PR With Naming Violation
- **GIVEN** A pull request contains a function without a verb prefix
- **WHEN** The CI naming validation workflow runs
- **THEN** The workflow MUST fail and the PR MUST be blocked from merging

### Requirement: Code Review Integration

The repository MUST include:
- CodeRabbit configuration (`.coderabbit.yaml`) with path-specific review rules
- SonarCloud configuration (`sonar-project.properties`) wired to the `SC0RED_clawndom` project
- CODEOWNERS file mapping directories to review teams

### Requirement: Makefile Quality Pipeline

The template MUST provide a Makefile with these targets:

| Target | What it runs |
|--------|-------------|
| `make lint` | Linter + type checker + formatter check |
| `make test` | Test suite with coverage threshold |
| `make security` | Dependency vulnerability audit |
| `make naming` | Naming conventions + abbreviations + skip comments |
| `make check` | lint + test + security + naming |
| `make sonar` | SonarCloud analysis (loads token from 1Password) |
| `make check-all` | check + sonar (required before every commit) |
| `make format` | Auto-fix lint and format |
| `make review` | CodeRabbit AI review on local changes |

#### Scenario: Developer Runs Full Check
- **GIVEN** A developer has made changes and wants to commit
- **WHEN** They run `make check-all`
- **THEN** All checks MUST run in sequence and the command MUST exit non-zero if any check fails

### Requirement: Module Structure and Boundaries

Each module directory MUST have an index or barrel export file that defines its public API. External consumers MUST import only from the barrel export, never from internal implementation files. Circular dependencies between modules MUST be forbidden and SHOULD be enforced by linting rules.

#### Scenario: Direct Internal Import
- **GIVEN** Module A imports a function directly from Module B's internal file (not its barrel export)
- **WHEN** The linter runs
- **THEN** The linter SHOULD flag the import as a violation of module boundaries

#### Scenario: Circular Dependency
- **GIVEN** Module A imports from Module B and Module B imports from Module A
- **WHEN** The dependency analysis runs
- **THEN** The circular dependency MUST be reported as a violation

### Requirement: Dependency Direction

Dependencies MUST flow inward following this hierarchy: handlers/routes → services → domain logic → types/interfaces. Infrastructure adapters (database clients, external API clients) MUST depend on domain interfaces, not the reverse. This ensures the domain layer has zero external dependencies.

#### Scenario: Domain Imports Infrastructure
- **GIVEN** A domain logic file imports directly from a database adapter
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag the import direction as a violation — the database adapter should depend on a domain interface instead
