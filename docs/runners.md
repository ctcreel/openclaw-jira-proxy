# Agent Runners

Runners are the strategies Clawndom uses to deliver work to a backend. Each runner implements the `AgentRunner` interface in `src/runners/types.ts`. The runner used for a given dispatch is resolved either:

- from the global registry (one singleton per type, configured at startup) — for runners whose configuration is fixed per deployment, or
- per-firing — for runners whose configuration varies per rule.

## Built-in runner types

| Type | Purpose | Registered at startup? |
| --- | --- | --- |
| `openclaw` | Default. Delivers via OpenClaw gateway RPC (`agent.wait`). | yes |
| `claude-cli` | Spawns `claude -p` subprocess. | yes |
| `openai` | Calls OpenAI `/v1/chat/completions`. | yes |
| `bedrock` | Calls AWS Bedrock `InvokeModel`. | yes |
| `shell` | Spawns the configured `command` as a child process. No prompt rendering, no template, no model invocation. | **no** — constructed per-firing |
| `null` | No-op, always returns `ok`. For testing only. | yes |

## The `shell` runner

The shell runner exists for periodic maintenance work that doesn't need an LLM — token refreshes, cache warmers, smoke checks. The first user is `gmail-watch-refresh` in winston-agency, which renews Gmail's push-watch subscription on a weekly cron.

### Config

```yaml
routing:
  schedule:
    rules:
      - name: gmail-watch-refresh
        cron: "0 9 * * 1"
        timezone: "America/New_York"
        runner:
          type: shell
          command: "python3 ./tools/refresh_gmail_watch.py"
          # cwd: "/some/dir"          # defaults to the agent workspace dir
          # env: { TOKEN: "..." }     # merged on top of process.env
          # timeoutMs: 60000          # default 300000 (5 min)
```

### Config fields

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `type` | `"shell"` | yes | — |
| `command` | string | yes | — |
| `cwd` | string | no | the agent workspace directory |
| `env` | record of string→string | no | `{}` |
| `timeoutMs` | positive integer | no | `300000` (5 min) |

`command` is parsed by `/bin/sh -c`, so shell features (pipes, redirections, env-var expansion) work as expected.

### Lifecycle events

The shell runner emits events on the EventBus identical in shape to the other runners:

- `runner.tool_call { tool: 'shell-spawn', args: { command, cwd, timeoutMs } }` — published immediately on spawn so the dashboard can render the firing as an in-flight tool call.
- `runner.complete { exitCode: 0, durationMs }` — clean exit (code 0). `RunResult.status = 'ok'`.
- `runner.error { reason, exitCode?, signal?, stderrTail }` — non-zero exit, timeout, signal, or spawn failure.
  - `reason: 'non-zero-exit'` — process exited with a non-zero code. `exitCode` is set; `stderrTail` carries the last 4 KiB of stderr.
  - `reason: 'timeout'` — `timeoutMs` elapsed without exit. `signal` is `'SIGTERM'` if the process exited during the kill grace period, or `'SIGKILL'` if escalation was needed.
  - `reason: 'signal'` — process terminated by a signal that wasn't a timeout-driven kill.
  - `reason: 'spawn-error'` — the `spawn()` call itself failed (e.g. `/bin/sh` missing). `stderrTail` carries the spawn error message.

### Process control

- The command runs with `shell: true` + `detached: true` so the shell and the actual command share a process group. On timeout the runner signals the **whole group** (`process.kill(-pid, 'SIGTERM')`); without `detached`, the shell would receive SIGTERM but the command's grandchildren would orphan.
- After SIGTERM the runner waits 5 seconds (the same `KILL_GRACE_MS` constant the claude-cli runner uses); if the group still hasn't exited, the runner escalates with SIGKILL. The reported `signal` reflects the kill that actually ended the process.

### Output capture

Stdout and stderr are each captured into a 64 KiB ring buffer (truncate-from-front). The last 4 KiB of stderr rides along on every `runner.error` event so the dashboard can show what failed without storing megabytes of subprocess noise.

### Security boundary — config-only

The shell runner is a **config-only** primitive in this phase. It is *not* registered in the global runner registry, and the worker only constructs one when a `routing.schedule` rule explicitly carries `runner: { type: 'shell', ... }`. Phase 3 of the scheduled-tasks feature will introduce an agent-callable scheduling tool; that tool's whitelist explicitly excludes `shell`. The intent: an LLM agent cannot create a scheduled shell command, only an operator editing config can.

A non-schedule rule with `runner: shell` parses successfully today (the schema is shared) but has no runtime effect — `getRunner('shell')` would throw `Unknown runner: shell`. Don't write rules that depend on it firing outside `routing.schedule`.

## Adding a new runner

1. Create `src/runners/<name>.runner.ts` implementing `AgentRunner`.
2. Add a config arm to the discriminated union in `src/runners/types.ts`.
3. Decide: register-at-startup (deployment-scoped config) or construct-per-firing (rule-scoped config). Most should be the former; shell is the exception.
4. Wire it from `src/server.ts` (registry path) or the worker (per-firing path).
5. Export from `src/runners/index.ts`.
