# Regulated-Buyer Readiness — Clawndom

Last updated: 2026-05-12. Audience: security / compliance reviewers (HIPAA, SOC2, FedRAMP). Read time: ~15 minutes. This document is shipped state only — facts that hold today, with explicit gaps called out at the bottom.

For the precise contractual specs, see `openspec/specs/agent-tool-use/spec.md`, `openspec/specs/agent-versioning/spec.md`, and `openspec/specs/observability/spec.md`.

## What Clawndom is

Clawndom is a runtime that bridges external event sources (Slack, Jira, GitHub, Gmail, scheduled tasks) to LLM-backed agents. Each event flows through a deterministic path: receive → validate signature → enqueue → dispatch to an agent runner → loop on `tool_use` blocks → emit a structured audit record per tool invocation → return.

The architecture is intentionally narrow. There is no general-purpose code execution surface, no agent-author-defined plugin system at runtime, and no path by which an agent's prompt context can reach a registered credential value.

## Audit trail

**What is recorded.** Exactly one NDJSON record per tool invocation, emitted by `src/lib/audit/emit.ts → writeAuditRecord(record)`. The schema (`src/lib/audit/types.ts → AuditRecord`) has these fields:

| Field | Type | Notes |
|---|---|---|
| `timestamp` | ISO-8601 UTC | Set at the moment the executor returns. |
| `agent_id` | string | From `AGENTS_CONFIG` (e.g. `winston`). |
| `route_id` | string | The `routing.<provider>.<routeName>` path in `clawndom.yaml`. |
| `tool_name` | string | Anthropic-facing tool name (derived from the tool directory or explicit `name:` override). |
| `args` | object | The `tool_use.input` from the model, with any value matching a resolved credential replaced by `<redacted>` (see "Redaction" below). |
| `result_summary` | unknown | The tool's return value. Truncated at 4 KB for strings; structured values pass through unchanged. Credential values inside are also redacted. |
| `error_summary` | string \| null | First line of exception message + type when the tool fails. `null` on success. |
| `latency_ms` | integer | Wall-clock duration of the helper call. |
| `request_id` | string | From the inbound event. |
| `correlation_id` | string | Defaults to `request_id` today. SPE-2079 will introduce real correlation propagation. |
| `agent_version` | string | `sha256:` hash of the involved repos at boot. Resolves via `GET /api/version`. |

**Where it goes.** Default `/var/log/clawndom-winston/audit.log`. Path configurable via `CLAWNDOM_AUDIT_LOG`. Append-only writes via `fs.appendFile` (atomic for line-sized payloads); parent directory created with `mkdir -p` on first write. The file is intentionally separate from operational logs so a log forwarder (Splunk / Datadog / SIEM) can target it without picking up unrelated noise.

**Redaction.** `src/lib/audit/redact.ts → redactCredentials(value, secrets)` walks the value recursively and replaces any string exactly matching a resolved credential with `<redacted>`. Applies to both `args` (the model-emitted input) and `result_summary` (the tool's return value, in case a misbehaving or adversary-influenced tool echoes the credential back). The Python MCP server (`scripts/clawndom_mcp_server.py`) mirrors the same redaction logic — different process address space means we can't share code, so the Python side reimplements `_redact_credentials` against the same rules.

**Audit-write failures are non-fatal to the request.** A filesystem error logs operationally (`logger.error`, structured) but does not propagate to the agent — losing a tool result because the audit FS is full is worse than the audit gap. SPE-2079 will define the policy for guaranteed audit delivery.

**Per-invocation correlation in production:** the `correlation_id` field exists today and is populated from `request_id` by default. When SPE-2079 lands, distinct events that are part of a single user request will share a correlation_id while keeping distinct request_ids. Audit consumers reading today's records get a stable field shape.

## Credential handling

**Resolution is server-side, at job-start.** Each declared tool's `tool.yaml` lists a `secrets:` map of canonical kwarg names → operator-side alias lists. At job-start, `src/services/tools/load-for-run.ts → resolveSecretFromAliases` tries each alias in order against the configured `SecretManager` and uses the first registered binding. The resolved value lives in the closure of the per-run preparation. It is keyed by the canonical name in the per-tool credentials map passed to the executor.

**Credentials never reach the model.** Verified at four boundaries:

1. **Anthropic registration**: the `tool_use` schema sent to the API contains only `name`, `description`, and `input_schema`. The `secrets` configuration is NEVER included. Inspection: `src/services/tools/mcp-bridge.ts → buildMCPRunFiles` — the materialized `tool-config.json` has the secret aliases (for the MCP server's own knowledge) but the value-bearing credentials live in a separate mode-600 file referenced by `CLAWNDOM_TOOL_CREDS_FILE`, passed only to the spawned MCP server subprocess, never serialized into prompt content.
2. **Process environment / /proc**: credential values are not placed in any env var. They are written to a mode-600 file and the **path** is the only thing that touches the env; the MCP server reads and unlinks the file at startup. This matters because Linux's `/proc/<pid>/environ` exposes the kernel-captured envp for the process lifetime — `os.environ.pop` can't scrub it. Path-only env keeps the literal credential out of every `/proc` dump. Verification: `tests/integration/credential-leakage-probe.test.ts` (Linux assertion).
3. **Audit log**: per "Redaction" above, substring scrubbing on both `args` and `result_summary` — catches credentials embedded inside larger strings (env dumps, error messages, stack traces).
4. **Operational logs**: structured logger fields are typed (`src/lib/logging`); credential values are not passed to logger calls. Defense-in-depth: tests verify credentials do not appear in `process.env` after a tool invocation.

**Secrets backends.** `src/secrets/` ships four providers, selectable at boot:

- **env** — reads from `process.env`. For developer machines.
- **1password** — shells `op read` to fetch from the operator's vault. Used by Winston in production today.
- **oauth** — refresh-token rotation (e.g. Slack DD-style flows). Self-refreshing on a per-TTL schedule.
- **file** — reads from a mode-0600 file. For service-account JSON keys.

**Secrets cache (SPE-2005).** `src/secrets/cache.ts` provides a tmpfs-backed cache so a restart loop doesn't shell `op read` once per binding per restart (which historically rate-limited the 1Password service account during a restart amplification incident). The cache is mode-0600 owned by the clawndom user; FileSecretCache refuses to read it if the mode is broader than 0600 OR the file's UID doesn't match the running process's effective UID. tmpfs lives in `/run/clawndom/` provisioned by the systemd unit's `RuntimeDirectory=` directive.

**Prompt-injection vector for credentials.** Closed. An agent reading attacker-controlled content (an email, a Slack DM) and asked to `printenv` or `cat /proc/self/environ` finds no useful tokens — the credentials aren't in the process environment. The agent CAN still misuse a declared tool (e.g. send an unauthorized Slack message via the legitimate `slack_post` tool) — that is the standard tool-use trust model, and the audit record captures every such call.

## Agent versioning

**The hash.** `src/services/version.service.ts → initializeAgentVersion` computes, at boot, a sha256 over sorted `<repo_name>:<sha>\n` lines for every involved repository: the Clawndom checkout itself, the agency workspace repo, agency-tools, plus any sharedTools-discovered nested repos. The hash is embedded in every audit record and exposed at `GET /api/version`.

**Per-repo breakdown.** `GET /api/version` returns:

```json
{
  "agent_version": "sha256:...",
  "repos": [
    {"name": "clawndom", "sha": "abc...", "dirty": false},
    {"name": "winston-agency", "sha": "def...", "dirty": false},
    {"name": "agency-tools", "sha": "ghi...", "dirty": false}
  ]
}
```

**Dirty-repo boot check.** `CLAWNDOM_ENV=production` makes boot fail if any involved repo has uncommitted changes (`git status --porcelain` non-empty). In dev mode, the check warns but proceeds — dev iteration is impossible if every uncommitted change blocks boot. A regulated-buyer deployment runs `CLAWNDOM_ENV=production`; an auditor reading any audit record's `agent_version` can dereference it to a fully-immutable set of repo SHAs.

## Boot-time validation gates

These run BEFORE the worker accepts the first event. Failure means boot fails fast with a clear error and the process exits. Operators see this immediately; no half-running state.

- **Schema validation** on `clawndom.yaml`: routes, rules, tools, memory, sessions, runners. Strict Zod schemas reject unknown keys.
- **Tool resolution**: every declared tool's directory must exist and contain `tool.yaml`.
- **Tool signature validation**: `impl.py`'s `invoke()` kwargs cross-checked against `tool.yaml`'s `args` + `secrets`. Optional-ness matches signature defaults; required-ness matches no-default; secrets have no defaults; no extra kwargs. Performed via Python stdlib `ast.parse()` — no module import, no top-level code execution.
- **Secret availability**: for every declared tool's `secrets:` entries, at least one alias must be registered in `SECRETS_CONFIG`. Boot fails listing the canonical name and acceptable aliases.
- **Memory namespace declaration**: per-rule memory bindings must reference declared namespaces; namespaces must declare registered embedding providers and vector stores.
- **Session strategy**: session-aware rules must reference registered SessionKeyStrategy implementations. Schedule rules cannot declare sessions.
- **Repo dirty check** (production mode only): every involved repo must be clean.

## Trust boundaries

| Boundary | Inside (trusted) | Outside (untrusted) |
|---|---|---|
| Webhook ingress | HMAC-validated payload | Anything failing HMAC validation |
| Agent prompt | System slot (Clawndom-rendered), tools-guide preamble | User slot (event payload, conversation history) |
| Tool dispatch | Resolved credentials (per-run closure) | Args from `tool_use.input` |
| Subprocess | scoped stdin (JSON payload with credentials) | shared filesystem, network |
| Audit log | NDJSON append from `writeAuditRecord` | Any other writer (none today) |

**Network egress.** Clawndom does not whitelist outbound destinations at the runtime layer; that's an infrastructure concern (security group, NACL, VPN). The deployment-side controls are documented in `docs/guides/OPERATIONS.md`.

**Tool egress.** Tool authors decide what their `impl.py` reaches. There is no per-tool egress policy at the framework level. For tighter sandboxing (e.g. seccomp-bpf, network namespaces), future work would extend the subprocess spawn site in `src/services/tools/executor.ts → runSubprocess`.

## What's tested

- 1060 unit + integration tests in clawndom; 109 in agency-tools.
- Coverage gate: 95% statements / 95% functions / 95% lines / 88% branches (branches ceiling is documented in `vitest.config.ts` — uncovered branches are unreachable `noUncheckedIndexedAccess` defensive narrows).
- End-to-end MCP integration test (`tests/integration/mcp-bridge-e2e.test.ts`) drives the real Python MCP server over stdio JSON-RPC, dispatches `tools/call` to a real Python `impl.py`, and verifies (a) the protocol round-trip, (b) `invoke()` receives args + credentials as kwargs, and (c) one audit record lands with credentials redacted from `args`.
- **Credential-leakage probe** (`tests/integration/credential-leakage-probe.test.ts`) — adversarial regression guard. An "evil" impl tries to exfiltrate the credential via every in-process path: `os.environ` direct lookup, full env dump, `/proc/self/environ`, and the credentials file (if its path can be recovered from env). The contract verified: the literal credential value MUST NOT be visible to the impl through any of these channels. (The literal value never lands in env because creds travel via a mode-600 file; the MCP server reads and unlinks the file and pops the path env var at startup; substring redaction covers the audit log even when an impl echoes the credential back inside a larger string.)
- **Multi-tool isolation probe** (`tests/integration/multi-tool-isolation.test.ts`) — two tools with distinct credentials dispatched in the same MCP session; each impl returns the first 8 chars + length of the credential it received. The contract verified: tool A sees only TOKEN_A, tool B sees only TOKEN_B, neither full value appears in either audit record. Regression guard against a naive global/singleton refactor of the per-tool credentials map.
- The credential-isolation contract is asserted: tests verify that a value passed as a credential to the executor does NOT appear in `process.env` after the call, and that a credential value stuffed into `args` by an adversary is replaced with `<redacted>` in the audit record.

## What's NOT yet shipped (explicit gaps)

This list is honest. A regulated-buyer review will ask about each of these; saying "yes that's a real gap, here's the timeline" is better than discovering it in their audit.

1. **Live end-to-end production verification of the SPE-2078 tool-use round trip.** The integration test exercises the MCP server in isolation. A real Slack DM → Winston → `tool_use` → impl.py → audit record round-trip has not been smoke-tested in production. (Next step: send a DM, watch `audit.log`.)
2. **Per-tool authorization.** "Only Winston in production can invoke `slack_post`" — no policy layer today. Tools are gated only by route declaration. Lands when a tool needs gating.
3. **Audit log retention / archival / immutability.** Filesystem NDJSON only. No append-only mode flag, no log-forwarder configuration, no time-bounded retention policy. Buyers specify their auditor's preferred backend (Postgres / S3 / SIEM); integration lands when they do.
4. **SIEM forwarding hooks.** Audit log is read-only-from-Clawndom's-perspective; a downstream tail-shipper is the integration point, configured at deployment.
5. **Network egress controls.** Framework-level allowlist is not implemented; relies on deployment-layer infrastructure.
6. **Tool subprocess sandboxing.** No seccomp-bpf, namespaces, or fs jail. Spawn is `node:child_process` with the Clawndom user's permissions.
7. **Other agent template migrations.** The slack-winston route is fully migrated to the SPE-2078 tool-use protocol. Patch / Scarlett / non-slack Winston routes still use the legacy bash-heredoc pattern with env-var credentials. The legacy pattern has the previously-documented prompt-injection exposure; migration is one route at a time as routes are touched.
8. **Unified logging framework (SPE-2079).** Operational, audit, agent-execution, and model-API log streams are separate today. SPE-2079 unifies them; until it lands, an SOC analyst correlates across streams manually.
9. **Multi-tenant isolation.** Clawndom is single-tenant per deployment. Multi-tenant separation would require per-tenant credential namespaces and audit destinations.
10. **Live external pen-test.** No third-party offensive review has been performed against the SPE-2078 surface.

## Compliance posture summary

| Concern | Status |
|---|---|
| Audit trail | ✓ Structured NDJSON, per-invocation, with redaction |
| Reproducibility (what was running) | ✓ `agent_version` hash + dirty-repo gate in production |
| Credential confinement | ✓ Server-side, never reach the model |
| Prompt-injection: credential exfiltration | ✓ Closed (no credentials in agent context; integration-tested via leakage probe + multi-tool isolation) |
| Prompt-injection: tool misuse | Open by design (logged via audit) |
| Boot-fail on misconfiguration | ✓ Schema + signature + secret-availability all checked |
| Append-only audit storage | Partial — appendFile semantics; no kernel-level enforcement |
| SIEM forwarding | External integration; framework provides the file |
| Retention policy | Operator-side (logrotate / SIEM TTL) |
| Per-tool authz | Not implemented |
| Network egress allowlist | Infrastructure layer |
| Subprocess sandboxing | Not implemented |

## Contact

Engineering owner: Christopher Creel (chris.creel@sc0red.com). Tickets in Jira project `SPE`. The SPE-2078 specs are at `openspec/specs/agent-tool-use/spec.md`, `openspec/specs/agent-versioning/spec.md`, and `openspec/specs/observability/spec.md`.
