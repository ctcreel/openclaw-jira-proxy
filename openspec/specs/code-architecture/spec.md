## Purpose

Defines the code architecture patterns that ensure maintainable, AI-friendly codebases with clear boundaries and predictable structure.

## Requirements

### Requirement: Layered Architecture

The codebase MUST follow a layered architecture with clear separation of concerns:
- **Handlers/Routes** — HTTP request handling, input validation, response formatting
- **Services** — Business logic orchestration, use case implementation
- **Domain** — Core business rules, entities, value objects
- **Infrastructure/Adapters** — Database access, external API clients, file I/O

Each layer MUST only depend on layers below it (handlers → services → domain → types). Infrastructure adapters MUST implement domain-defined interfaces.

#### Scenario: Handler Contains Business Logic
- **GIVEN** A route handler contains database queries and business rule validation
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag it — business logic belongs in the service layer, database access in the infrastructure layer

### Requirement: Module README Documentation

Each module directory that contains more than 3 files SHOULD include a brief README.md (under 20 lines) describing:
- The module's purpose (one sentence)
- Its public API (what to import)
- The design pattern used (if any)
- Any important constraints or gotchas

This serves as progressive context disclosure — AI agents read the module README before modifying files in that module.

#### Scenario: AI Modifies Module Without README
- **GIVEN** An AI agent needs to modify a file in a module without a README
- **WHEN** The agent reads the module directory
- **THEN** The agent has no guidance on the module's purpose or patterns, increasing the risk of inconsistent changes

### Requirement: No God Objects or God Functions

No single class MUST accumulate more than 5 public methods. No single function MUST accept more than 3 positional parameters (use an options/config object for additional parameters). These limits prevent the accumulation of responsibility that makes code hard for both humans and AI to reason about.

#### Scenario: Class With Too Many Methods
- **GIVEN** A class has 8 public methods
- **WHEN** Code review runs
- **THEN** The reviewer MUST recommend splitting the class into focused, single-responsibility classes

### Requirement: Explicit Over Implicit

Configuration, wiring, and dependencies MUST be explicit — never rely on implicit conventions that an AI agent cannot discover by reading the code. Dependency injection MUST be preferred over service locators or global state. Magic strings MUST be replaced with typed constants or enums.

#### Scenario: Hidden Configuration Convention
- **GIVEN** A service reads configuration from a file path determined by an undocumented naming convention
- **WHEN** An AI agent needs to add a new configuration value
- **THEN** The agent cannot discover the convention without tribal knowledge, leading to errors
