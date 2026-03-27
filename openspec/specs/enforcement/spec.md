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
- Secrets scanning (gitleaks)
- Conventional Commits message validation
- No-commit-to-branch guard (main, production, demo)

#### Scenario: Commit With Type Error
- **GIVEN** A developer stages a file with a type error
- **WHEN** They attempt to commit
- **THEN** The pre-commit hook MUST block the commit and report the type error

### Requirement: Pre-Push Hooks

The template MUST validate branch naming on every push. Branch names MUST follow the format: `{type}/{TICKET-ID}-{description}` where type is one of: feature, bugfix, hotfix, chore, docs, refactor, test.

Long-lived branches (development, testing, demo, production) MUST be allowed without validation.

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

The template MUST run these checks on every pull request via GitHub Actions:
- Lint (linter + type checker + formatter check)
- Test (with coverage threshold enforcement)
- Security (dependency audit)
- Naming validation (naming conventions + abbreviations + skip comments)
- SonarCloud analysis
- Deployment validation (CDK synth dry-run)

All checks MUST pass before merge is allowed.

#### Scenario: PR With Naming Violation
- **GIVEN** A pull request contains a function without a verb prefix
- **WHEN** The CI naming validation workflow runs
- **THEN** The workflow MUST fail and the PR MUST be blocked from merging

### Requirement: Secrets Scanning

The template MUST include gitleaks configuration with rules for at minimum:
- AWS credentials (access key, secret key, session token)
- Generic API keys, secrets, passwords
- Private keys (RSA, EC, DSA, OpenSSH, PGP)
- Database connection URLs with credentials (postgres, mysql, mongodb, redis)
- GitHub tokens (PAT, OAuth, App)
- JWT tokens
- Slack webhooks and tokens
- 1Password references MUST be explicitly allowed (not flagged as secrets)

#### Scenario: AWS Key in Source Code
- **GIVEN** A developer accidentally pastes an AWS access key into a config file
- **WHEN** They attempt to commit
- **THEN** Gitleaks MUST block the commit and identify the secret type

### Requirement: Code Review Integration

The template MUST include:
- CodeRabbit configuration (.coderabbit.yaml) with path-specific review rules
- SonarCloud configuration (sonar-project.properties)
- CODEOWNERS file mapping directories to review teams
- gitstream configuration (.cm/gitstream.cm) for automated PR labeling, size classification, test coverage checks, and production guards

#### Scenario: PR Without Tests
- **GIVEN** A pull request modifies source files but includes no test files
- **WHEN** gitstream evaluates the PR
- **THEN** gitstream MUST add a "needs-tests" label and request changes

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
