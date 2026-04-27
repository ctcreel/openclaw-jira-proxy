## Purpose

Defines the code architecture patterns that ensure maintainable, AI-friendly codebases with clear boundaries and predictable structure.

## Requirements

### Requirement: Layered Architecture

The codebase MUST follow a layered architecture with clear separation of concerns:
- **Handlers/Routes** — HTTP request handling, input validation, response formatting
- **Services** — Business logic orchestration, use case implementation
- **Domain** — Core business rules, entities, value objects
- **Infrastructure/Adapters** — Database access, external API clients, file I/O, agent runners

Each layer MUST only depend on layers below it (handlers → services → domain → types). Infrastructure adapters MUST implement domain-defined interfaces.

The `src/runners/` directory is an infrastructure adapter layer. Worker services MUST depend on the `AgentRunner` interface defined in `src/runners/types.ts` — never on a concrete runner class. Concrete runner implementations (`OpenClawRunner`, `ClaudeCliRunner`, etc.) MUST be instantiated only in `src/server.ts` during startup wiring.

#### Scenario: Handler Contains Business Logic
- **GIVEN** A route handler contains database queries and business rule validation
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag it — business logic belongs in the service layer, database access in the infrastructure layer

#### Scenario: Worker Imports Concrete Runner
- **GIVEN** `worker.service.ts` imports `ClaudeCliRunner` directly
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag it — the worker MUST only import the `AgentRunner` interface and `getRunner` from the registry

### Requirement: Module README Documentation

Each module directory that contains more than 3 files SHOULD include a brief README.md (under 20 lines) describing:
- The module's purpose (one sentence)
- Its public API (what to import)
- The design pattern used (if any)
- Any important constraints or gotchas

This applies to `src/runners/`. The runners README MUST describe the `AgentRunner` interface, how to add a new runner (implement interface + register at startup), and note that concrete runner instantiation belongs in `src/server.ts`, not in services.

#### Scenario: AI Modifies Module Without README
- **GIVEN** An AI agent needs to modify a file in a module without a README
- **WHEN** The agent reads the module directory
- **THEN** The agent has no guidance on the module's purpose or patterns, increasing the risk of inconsistent changes

### Requirement: No God Objects or God Functions

No single class MUST accumulate more than 5 public methods. No single function MUST accept more than 3 positional parameters (use an options/config object for additional parameters).

`AgentRunner` implementations MUST expose at most: `run`, `connect`, `close`, `isHealthy` — four methods. This limit enforces single-responsibility per runner.

#### Scenario: Class With Too Many Methods
- **GIVEN** A class has 8 public methods
- **WHEN** Code review runs
- **THEN** The reviewer MUST recommend splitting the class into focused, single-responsibility classes

### Requirement: Explicit Over Implicit

Configuration, wiring, and dependencies MUST be explicit — never rely on implicit conventions that an AI agent cannot discover by reading the code. Dependency injection MUST be preferred over service locators or global state. Magic strings MUST be replaced with typed constants or enums.

Runner type names (`"openclaw"`, `"claude-cli"`, `"openai"`, `"bedrock"`, `"null"`) are the sole exception — they are string literals in the Zod discriminated union schema and serve as the canonical definition. All other references to runner type names MUST derive from the schema, not from ad-hoc string comparisons.

Runner registration MUST be explicit at startup: each runner type used by any provider MUST have a corresponding `registerRunner()` call in `src/server.ts`. There MUST be no auto-discovery, no convention-based loading.

#### Scenario: Hidden Configuration Convention
- **GIVEN** A service reads configuration from a file path determined by an undocumented naming convention
- **WHEN** An AI agent needs to add a new configuration value
- **THEN** The agent cannot discover the convention without tribal knowledge, leading to errors

#### Scenario: Implicit Runner Resolution
- **GIVEN** A runner is instantiated inside the worker based on an env var check rather than registry lookup
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag it — all runner resolution MUST go through `getRunner()` from the registry

### Requirement: Strategy Pattern Consistency

The codebase uses the Strategy pattern in three places: signature validation (`src/strategies/signature/`), routing (`src/strategies/routing/`), and agent runners (`src/runners/`). All three MUST follow the same structural conventions:

- A `types.ts` file defining the strategy interface and associated types
- A `registry.ts` file with `register*`, `get*`, `reset*` functions
- One file per strategy/runner implementation
- An `index.ts` barrel export
- A `README.md` describing the module

New runner implementations MUST follow this pattern without exception. Adding a new runner MUST require only: (1) implementing `AgentRunner`, (2) registering it in `src/server.ts`. No other files MUST be modified.

#### Scenario: New Runner Added Outside Pattern
- **GIVEN** A developer adds a new runner by adding a case to a switch statement in `worker.service.ts`
- **WHEN** Code review runs
- **THEN** The reviewer MUST reject it — the runner MUST be a separate file implementing `AgentRunner` and registered via `registerRunner()`

### Requirement: Runtime / Application Boundary

Clawndom is a runtime, not an application. The runtime's surface is: transport ingress (HTTP webhooks, Slack Socket Mode, scheduled cron, internal task dispatch), routing AST evaluation, queueing, prompt rendering, runner orchestration, observability. The runtime MUST NOT depend on domain-specific service SDKs (Gmail, Slack messaging, calendar APIs, payment systems, accounting systems) — those dependencies belong in the per-agent shared library (`agency-tools`), not in Clawndom.

A new feature MUST be evaluated against this boundary before landing in Clawndom: if the feature requires importing a vendor SDK that Clawndom does not already depend on, the feature MUST be implemented in `agency-tools` or in a per-agent helper, not in Clawndom.

Provider transports (e.g., Slack Socket Mode) belong in Clawndom because they are orchestration — they receive events and route them through the existing pipeline. Domain payload knowledge (e.g., parsing a Slack message into intent, extracting a Jira issue key, looking up a calendar event) sits at the edge — context strategies, condition AST, template rendering — but MUST NOT cause Clawndom to import API SDKs for those services.

Agent code (templates, helper scripts inside agent repos) MUST treat Clawndom as a black box, communicating only via the runtime's public surface: templates, routing rules, configuration. Agent code MUST NOT import Clawndom internals.

#### Scenario: New Helper Adds Vendor SDK
- **GIVEN** A pull request adds `@gmail/api` (or any other domain-service SDK) as a Clawndom dependency to support a new email-send capability
- **WHEN** Code review runs
- **THEN** The reviewer MUST reject it — the helper belongs in `agency-tools`, not in Clawndom

#### Scenario: Transport Strategy Within Boundary
- **GIVEN** A pull request adds `@slack/socket-mode` to enable Slack Socket Mode as a new transport
- **WHEN** Code review runs
- **THEN** The reviewer MUST accept the dependency — Socket Mode is orchestration (transport ingress), not domain logic

#### Scenario: Per-Agent Helper Reaches Into Runtime
- **GIVEN** An agent's helper code reaches into Clawndom internals — for example, manipulating Clawndom's BullMQ Redis queue keys directly, or invoking Clawndom-internal services not exposed as part of the runtime's public surface
- **WHEN** Code review runs
- **THEN** The reviewer MUST reject it — agent helpers MUST treat Clawndom as a black box, communicating only via the runtime's public surface (templates, routing rules, configuration)
