## Tasks: Agent Runner Strategy

### Phase 1: Runner Infrastructure

- [ ] Create `src/runners/types.ts` — `AgentRunner` interface, `RunOptions`, `RunResult`, runner config Zod schemas (`openclawRunnerConfigSchema`, `claudeCliRunnerConfigSchema`, `openaiRunnerConfigSchema`, `bedrockRunnerConfigSchema`, `runnerConfigSchema` discriminated union)
- [ ] Create `src/runners/registry.ts` — `registerRunner`, `getRunner`, `getRegisteredRunners`, `resetRunners`
- [ ] Create `src/runners/null.runner.ts` — `NullRunner` implementation
- [ ] Create `src/runners/index.ts` — barrel export for all runners and types
- [ ] Add `runner` optional field to `providerSchema` in `src/config.ts` using `runnerConfigSchema`
- [ ] Add `resetRunners()` call to `resetSettings()` in `src/config.ts` so test teardown clears both

### Phase 2: Runner Implementations

- [ ] Create `src/runners/openclaw.runner.ts` — `OpenClawRunner` wrapping `GatewayClient.runAndWait`, implements `connect`, `close`, `isHealthy`, captures `renderedPrompt`
- [ ] Create `src/runners/claude-cli.runner.ts` — `ClaudeCliRunner` spawning `claude -p` subprocess, `buildClaudeArgs`, `spawnClaude` (stream-json parsing, timeout enforcement), `isHealthy` binary check
- [ ] Create `src/runners/openai.runner.ts` — `OpenAiRunner` calling `/v1/chat/completions` via `fetch`, `AbortSignal.timeout` for timeout enforcement
- [ ] Create `src/runners/bedrock.runner.ts` — `BedrockRunner` calling `InvokeModel` via `@aws-sdk/client-bedrock-runtime`, try/require guard so package is optional at runtime
- [ ] Add `which` to `package.json` dependencies for `ClaudeCliRunner.isHealthy()` binary path resolution

### Phase 3: Worker Integration

- [ ] Refactor `processJob` in `src/services/worker.service.ts` — replace `gatewayClient.runAndWait` call with `getRunner(provider.runner?.type ?? 'openclaw').run(...)`, add prompt observability logging (debug: full prompt, info: hash + length)
- [ ] Remove `gatewayClient` parameter from `createWorker` options interface in `src/services/worker.service.ts`
- [ ] Update `createWorker` callers in `src/server.ts` to remove `gatewayClient` argument

### Phase 4: Health Service

- [ ] Refactor `src/services/health.service.ts` — replace hardcoded gateway WebSocket check with `getRegisteredRunners().filter(r => r.isHealthy).map(r => ...)` runner health checks
- [ ] Update health check name format from `gateway-websocket` to `runner:<name>` (e.g., `runner:openclaw`, `runner:claude-cli`)

### Phase 5: Startup Wiring

- [ ] Refactor `src/server.ts` startup sequence — determine needed runner types from `settings.providers`, instantiate only required runners, register all, call `connect()` on runners that implement it
- [ ] Remove direct `GatewayClient` instantiation from top-level server scope — move inside the `openclaw` runner conditional block
- [ ] Register `NullRunner` at startup (enables `null` runner type in `PROVIDERS_CONFIG` for integration test scenarios)

### Phase 6: Preview Script

- [ ] Create `scripts/preview-template.ts` — reads `--template` and `--payload` args, calls `renderTemplate`, writes to stdout
- [ ] Add `preview-template` target to `Makefile`: `pnpm tsx scripts/preview-template.ts --template $(TEMPLATE) --payload $(PAYLOAD)`
- [ ] Create `samples/` directory with `.gitkeep` and add sample payload files for Jira issue-updated and GitHub PR-opened events

### Phase 7: Tests

- [ ] Create `tests/runners/null.runner.test.ts` — returns ok, captures renderedPrompt
- [ ] Create `tests/runners/registry.test.ts` — register, resolve, unknown name throws, reset clears
- [ ] Create `tests/runners/openclaw.runner.test.ts` — delegates to gatewayClient, maps result, captures renderedPrompt, connect/close/isHealthy
- [ ] Create `tests/runners/claude-cli.runner.test.ts` — subprocess spawned with correct args, stream-json parsed, timeout kills process, workDir applied, systemPrompt included when configured
- [ ] Create `tests/runners/openai.runner.test.ts` — correct endpoint called, bearer token sent, model from options overrides config model, AbortSignal timeout, non-2xx returns error status
- [ ] Create `tests/runners/bedrock.runner.test.ts` — InvokeModelCommand called with correct modelId and region, model from options overrides config, ambient credentials (no key in config)
- [ ] Update `tests/services/worker.service.test.ts` — replace `gatewayClient` mock with `NullRunner` registered in registry, add assertions for prompt hash/length logged at info level, add test for `renderedPrompt` in run result
- [ ] Update `tests/services/health.service.test.ts` — replace gateway WebSocket check assertions with runner health check assertions (`runner:openclaw`, etc.)
- [ ] Update `tests/integration/worker.integration.test.ts` — remove `gatewayClient` injection, register `NullRunner` or mock `OpenClawRunner` before tests
- [ ] Update `tests/setup.ts` — add `resetRunners()` to global `beforeEach` teardown

### Phase 8: Documentation

- [ ] Add `src/runners/README.md` — module purpose, public API (import from barrel), `AgentRunner` interface summary, how to add a new runner (implement interface + register at startup)
- [ ] Update `CLAUDE.md` architecture section to include `src/runners/` in the directory map
- [ ] Update `README.md` `PROVIDERS_CONFIG` documentation with `runner` field examples for each runner type
- [ ] Update `docs/guides/ENVIRONMENT_VARIABLES.md` — note that `ANTHROPIC_API_KEY` must NOT be set in the launchd plist when using the `claude-cli` runner (subscription billing depends on clean host environment)
