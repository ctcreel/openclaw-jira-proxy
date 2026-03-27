## Purpose

Defines the quality standards, principles, and enforcement requirements that all Sc0red template repositories MUST implement. This spec is language-agnostic — it describes WHAT must exist, not HOW it's implemented.

## Requirements

### Requirement: Core Principles

The template MUST enforce these development principles across all code:

1. **Fail Fast** — No defensive code. No fallback values on internal objects. If something is wrong, the code MUST throw immediately.
2. **Validate at Boundaries Only** — External input (API requests, environment variables, user input) MUST be validated once at the boundary. Internal code MUST trust validated data completely.
3. **No Skip Comments** — Comments that bypass linting, type checking, security scanning, or coverage MUST be forbidden and enforced by tooling.
4. **No Unsafe Types** — Language-specific unsafe types (`any` in TypeScript, bare `except` in Python) MUST be forbidden.

#### Scenario: Fail Fast Enforcement
- **GIVEN** A developer writes code that silently handles a null value with a fallback
- **WHEN** The enforcement tooling runs
- **THEN** The code review (CodeRabbit) MUST flag it as a violation

#### Scenario: Skip Comment Detection
- **GIVEN** A developer adds a lint-skip comment to suppress a warning
- **WHEN** The skip-comments enforcement script runs
- **THEN** The script MUST exit with code 1 and report the violation with file and line number

### Requirement: Naming Conventions

The template MUST enforce consistent naming conventions via automated tooling.

| Element | Convention |
|---------|------------|
| Classes/Types | PascalCase |
| Functions | Language-appropriate case with verb prefix |
| Constants | SCREAMING_SNAKE_CASE |
| Variables | Language-appropriate case |
| Files | kebab-case |

Functions MUST start with a verb from the approved verb list. The enforcement script MUST support an escape hatch comment for framework-required exceptions.

#### Scenario: Function Without Verb Prefix
- **GIVEN** A developer writes a top-level exported function named "userData"
- **WHEN** The naming conventions script runs
- **THEN** The script MUST report a violation suggesting a verb prefix

#### Scenario: Escape Hatch for Framework Conventions
- **GIVEN** A framework requires a non-standard function name (e.g., Next.js route handler `GET`)
- **WHEN** The developer adds the escape hatch comment `// noqa: NAMING001`
- **THEN** The naming conventions script MUST skip that line

### Requirement: Forbidden Abbreviations

The template MUST enforce full words over abbreviations via automated tooling. At minimum, these abbreviations MUST be forbidden: msg, req, res, resp, ctx, cfg, conf, db, conn, mgr, usr, pwd, obj, impl, env, tmp, temp, idx, cnt, btn, err.

#### Scenario: Abbreviation in Variable Name
- **GIVEN** A developer declares a variable using a forbidden abbreviation
- **WHEN** The abbreviations enforcement script runs
- **THEN** The script MUST report the violation with the suggested full word

### Requirement: Test Coverage

The template MUST enforce a minimum of 95% test coverage across statements, branches, functions, and lines. Tests MUST focus on behavior, not implementation.

#### Scenario: Coverage Below Threshold
- **GIVEN** The test suite achieves 90% statement coverage
- **WHEN** The test command runs
- **THEN** The command MUST exit with a non-zero code

### Requirement: AI Coding Standards Document

The template MUST include a CLAUDE.md file at the repository root that provides:
- Critical pre-completion requirements (what to run before any task is done)
- Core rules (fail fast, boundary validation, skip comments, type safety)
- Naming conventions with examples
- Forbidden abbreviations list
- Code structure guidelines (imports, function signatures)
- Testing requirements
- Design patterns table referencing actual source locations
- Infrastructure and secrets management details
- Branch strategy and git workflow
- Quality pipeline commands
- Developer setup instructions

#### Scenario: New Developer Onboarding
- **GIVEN** A developer (human or AI) opens the repository for the first time
- **WHEN** They read CLAUDE.md
- **THEN** They MUST have sufficient information to set up their environment, understand all standards, and run all checks

### Requirement: Documentation Suite

The template MUST include the following documentation:
- README.md — project overview, prerequisites, installation, development commands
- docs/standards/STANDARDS.md — engineering standards with enforcement tools table
- docs/standards/NAMING_CONVENTIONS.md — naming rules for code and infrastructure
- docs/guides/BRANCHING.md — branch strategy and feature branch naming
- docs/guides/ENVIRONMENT_VARIABLES.md — all configuration variables
- docs/guides/SECRETS_MANAGEMENT.md — 1Password integration workflow
- docs/design-patterns-guide.md — patterns used in the template with locations

### Requirement: File Size Limits

Files MUST NOT exceed 300 lines of code (excluding imports, type definitions, and comments). Functions and methods MUST NOT exceed 50 lines. When a file exceeds the limit, it MUST be split into focused, single-responsibility modules. These limits MUST be enforced by code review tooling (CodeRabbit) and SHOULD be enforced by linting rules where available.

#### Scenario: File Exceeds Size Limit
- **GIVEN** A source file contains 350 lines of implementation code
- **WHEN** CodeRabbit reviews the pull request
- **THEN** CodeRabbit MUST flag the file as exceeding the 300-line limit and recommend splitting

#### Scenario: Function Exceeds Size Limit
- **GIVEN** A function contains 65 lines of code
- **WHEN** CodeRabbit reviews the pull request
- **THEN** CodeRabbit MUST flag the function as exceeding the 50-line limit and recommend extraction

### Requirement: Single Responsibility Per File

Each source file MUST have a single, clear responsibility — one class, one factory, one service, or one cohesive group of related utilities. File names MUST describe their contents specifically. Generic names (`utils.ts`, `helpers.py`, `common.ts`) MUST be forbidden in favor of descriptive names (`retry-utils.ts`, `date-formatting.ts`).

#### Scenario: Generic File Name
- **GIVEN** A developer creates a file named `utils.ts`
- **WHEN** Code review runs
- **THEN** The reviewer MUST request a more descriptive name that reflects the file's specific responsibility

### Requirement: Type-First Design

Shared types MUST be defined in dedicated type files, not inline within implementation files. All exported functions MUST have explicit return type annotations — inferred return types are NOT sufficient for public APIs. Interface and protocol types MUST be defined for all module boundaries.

#### Scenario: Exported Function Without Return Type
- **GIVEN** An exported function has no explicit return type annotation
- **WHEN** The type checker runs in strict mode
- **THEN** The type checker MUST report an error

### Requirement: Immutability and Pure Functions

Function parameters MUST be treated as immutable — code MUST NOT mutate arguments passed to functions. Pure functions (no side effects) SHOULD be preferred over stateful code. Side effects (database writes, API calls, file I/O) MUST be isolated to adapter and infrastructure layers, not mixed into business logic.

#### Scenario: Parameter Mutation
- **GIVEN** A function modifies an object passed as a parameter
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag it as a violation and recommend creating a new object instead

### Requirement: AI Coding Standards Document (CLAUDE.md) — Size Constraint

CLAUDE.md MUST be concise — under 60 lines of actionable instructions. Detailed documentation MUST live in docs/, not in CLAUDE.md. CLAUDE.md MUST focus exclusively on: what commands to run, what is forbidden, where to find things, and critical architectural context. Never instruct the AI to do what a linter or hook already enforces — mechanical enforcement always takes precedence over instructions.

#### Scenario: CLAUDE.md Exceeds Size Limit
- **GIVEN** CLAUDE.md contains 120 lines of instructions
- **WHEN** A developer reviews the template
- **THEN** The excess content MUST be moved to docs/ and CLAUDE.md MUST reference those docs instead
