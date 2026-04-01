## Change: Completion-Aware Isolated Session Delivery

### Summary

Wire the worker to use the existing `GatewayClient.runAndWait()` WebSocket RPC (already implemented in `gateway-client.ts`) instead of the fire-and-forget CLI subprocess `sendToSession()` in `gateway-client.service.ts`. Each webhook spawns an **isolated session** that blocks the BullMQ job until the agent run reaches a terminal state.

### Problem

The domain spec (`webhook-proxy-domain`) requires completion-aware processing:

> "The worker MUST NOT mark a job as complete until the corresponding OpenClaw agent run has reached a terminal state."

The implementation does not satisfy this requirement. Here's what currently happens:

1. BullMQ dequeues a job (concurrency: 1 ✅)
2. Worker renders the message template ✅
3. Worker calls `sendToSession()` which shells out to `openclaw gateway call sessions.send` ❌
4. `sessions.send` returns as soon as the message is **delivered to the gateway** (~4 seconds) ❌
5. Job is marked complete. Next job dequeues immediately. ❌

The result: all queued webhooks drain at network speed, not at run-completion speed. When Srikanth transitions 4 tickets in quick succession, Patch receives all 4 messages within seconds — piled into her main session. The serialization guarantee is completely broken.

Meanwhile, `gateway-client.ts` contains a fully implemented `GatewayClient` class with a `runAndWait()` method that:
1. Calls the `agent` RPC (which creates an isolated session)
2. Receives a `runId`
3. Calls `agent.wait` with the `runId`
4. Blocks until the run reaches a terminal state (`ok` | `error` | `timeout`)

This is exactly what the spec demands. It's already written. It's just not wired in.

### Root Cause

Two delivery modules exist in `src/services/`:

| Module | Mechanism | Completion-Aware | Used By Worker |
|--------|-----------|-----------------|----------------|
| `gateway-client.ts` | WebSocket `agent` + `agent.wait` RPC | ✅ Yes — blocks until terminal state | ❌ No |
| `gateway-client.service.ts` | CLI subprocess `sessions.send` | ❌ No — fire-and-forget | ✅ Yes |

Additionally, `session-monitor.service.ts` implements a third approach (file-polling `sessions.json` for idle detection) that is also unused. Three delivery mechanisms, none used correctly.

The `AGENT_WAIT_TIMEOUT_MS` config value (set to 3,600,000ms in the launchd plist) is parsed by `config.ts` but never referenced by the worker — dead config.

### Solution

#### 1. Worker uses `GatewayClient.runAndWait()` instead of `sendToSession()`

Replace the `processJob()` function in `worker.service.ts` to:

1. Acquire a shared `GatewayClient` instance (one WebSocket connection per process)
2. Call `runAndWait()` with:
   - `message`: the rendered template (same as today)
   - `agentId`: from routing resolution (same as today)
   - `model`: from `resolveModel()` (currently resolved but not passed to delivery)
   - `sessionKey`: `hook:jira:<jobId>` (isolated — not `agent:patch:main`)
3. Block until `runAndWait()` returns
4. Mark job complete/failed based on the `AgentRunResult.status`

The `agent` RPC creates an isolated session per call. This means:
- Each webhook gets its own session context — no bleed between tickets
- Patch's main session stays clean for human conversations
- The next job doesn't start until the current one finishes

#### 2. Wire `AGENT_WAIT_TIMEOUT_MS` as `waitTimeoutMs`

The config value already exists and is already 3,600,000ms (1 hour). Pass it to `runAndWait()` as the timeout.

#### 3. Pass `model` from routing rules to the agent RPC

`resolveModel()` already determines the right model per webhook payload. Currently it logs the result and discards it. Pass it through to `runAndWait()` so the isolated session uses the correct model (e.g., Opus for Plan/Ready for Dev, Sonnet/default for Verified in Dev).

#### 4. Clean up dead code

- `gateway-client.service.ts` — delete entirely. No other module imports it.
- `session-monitor.service.ts` — delete entirely. Unused file-polling approach, superseded by WebSocket `agent.wait`.

### Backward Compatibility

- **Routing rules**: No change. Same `PROVIDERS_CONFIG` format, same `resolveAgent()` logic.
- **Model rules**: No change. Same `resolveModel()` logic, but the result now actually reaches the agent session.
- **Queue behavior**: No change. Same BullMQ queue, same concurrency: 1. Jobs just block longer (correctly).
- **Template rendering**: No change. Same `renderTemplate()` output.
- **Session key change**: Webhooks will create isolated sessions (`hook:jira:<jobId>`) instead of dumping into `agent:patch:main`. This is the intended behavior per the domain spec. Patch's main session is no longer interrupted by webhooks.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/services/worker.service.ts` | Modify | Replace `sendToSession()` call with `GatewayClient.runAndWait()`. Add `GatewayClient` lifecycle (init/close). Pass `model` to `runAndWait()`. |
| `src/services/gateway-client.ts` | Minor modify | Accept `model` param in `runAndWait()`. May need minor param adjustments for isolated session key format. |
| `src/services/gateway-client.service.ts` | Delete | Dead code — fire-and-forget CLI subprocess delivery. |
| `src/services/session-monitor.service.ts` | Delete | Dead code — file-polling idle detection. |
| `src/server.ts` | Modify | Initialize shared `GatewayClient` at startup, pass to worker factory, close on shutdown. |
| `src/config.ts` | No change | `agentWaitTimeoutMs` already parsed and available. |
| `tests/unit/services/worker.service.test.ts` | Modify | Update to mock `GatewayClient.runAndWait()` instead of `sendToSession()`. Add completion-aware test cases. |
| `tests/unit/services/gateway-client.service.test.ts` | Delete | Tests for deleted module. |
| `tests/unit/services/session-monitor.service.test.ts` | Delete (if exists) | Tests for deleted module. |

### What This Fixes

1. **Webhook flooding** — Jobs block until the agent finishes. Second webhook waits for first to complete.
2. **Session pollution** — Each webhook gets an isolated session. Patch's main session stays clean.
3. **Model routing** — `resolveModel()` output actually reaches the agent (currently discarded).
4. **Dead config** — `AGENT_WAIT_TIMEOUT_MS` is finally used.
5. **Dead code** — Two unused delivery modules removed.

### Estimation

- **Risk:** Low — The hard part (WebSocket RPC client with `agent` + `agent.wait`) is already implemented and matches the domain spec. This change wires it in and removes dead alternatives.
- **Intensity:** Low — Core change is ~30 lines in `worker.service.ts`. Server lifecycle is ~10 lines. Everything else is deletion.
- **Story Points:** 2

### Testing Plan

1. **Unit:** Mock `GatewayClient.runAndWait()` in worker tests — verify job blocks until `runAndWait` resolves, verify failure/timeout paths.
2. **Integration:** Fire two webhooks in quick succession. Verify second job doesn't start processing until first completes (check timestamps in logs).
3. **Manual:** Trigger a Jira transition while Patch is processing another. Verify she finishes the first before starting the second. Verify her main session is undisturbed.
