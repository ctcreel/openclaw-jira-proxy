# src/runners/

Pluggable agent runner abstraction. Decouples prompt delivery from any specific execution backend.

## Public API

Import from `./index.ts`:

- `AgentRunner` interface, `RunOptions`, `RunResult` types
- `registerRunner()`, `getRunner()`, `getRegisteredRunners()`, `resetRunners()`
- Concrete runners: `NullRunner`, `OpenClawRunner`, `ClaudeCliRunner`, `OpenAiRunner`, `BedrockRunner`

## Pattern

Strategy pattern — same structure as `src/strategies/routing/` and `src/strategies/signature.ts`.

## Adding a new runner

1. Create `src/runners/<name>.runner.ts` implementing `AgentRunner`
2. Add its type to the discriminated union in `types.ts`
3. Register it in `src/server.ts` startup wiring
4. Export from `index.ts`

Concrete runners are instantiated **only** in `src/server.ts`. Services import the interface and `getRunner()`.
