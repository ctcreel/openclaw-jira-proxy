## ADDED Requirements

### Requirement: Per-Tool-Invocation Audit Stream

Clawndom MUST emit exactly one structured audit record per tool invocation (each `tool_use` block dispatched through the executor). Records MUST be written as newline-delimited JSON (NDJSON), one record per line, to a dedicated audit log file separate from the operational log stream. The audit log path MUST be configurable (default `/var/log/clawndom-winston/audit.log`).

Each audit record MUST contain the following fields:

- `timestamp` — ISO 8601 UTC timestamp of the invocation start.
- `agent_id` — identifier of the agent whose route handled the event.
- `route_id` — identifier of the routing rule that matched.
- `tool_name` — the API-facing tool name (derived from the directory path or explicit `name:` override).
- `args` — the agent-emitted `tool_use.input` object, with any credential values redacted (see Credential Redaction requirement).
- `result_summary` — the `tool_result` content, truncated to a reasonable cap (e.g., 4 KB).
- `error_summary` — `null` on success; on failure, the exception class plus the first line of its message.
- `latency_ms` — duration of the helper call in milliseconds.
- `request_id` — identifier of the inbound event being handled.
- `correlation_id` — identifier for joining audit records to related operational logs and child events. In this change, `correlation_id` defaults to the value of `request_id`; subsequent changes may introduce true correlation propagation that distinguishes the two.
- `agent_version` — the boot-time `agent_version` hash (see agent-versioning capability).

#### Scenario: Exactly One Record Per Invocation
- **GIVEN** An agent run that issues three `tool_use` blocks
- **WHEN** The run completes (success or failure)
- **THEN** The audit log MUST contain exactly three records, one per `tool_use`

#### Scenario: Failure Still Produces A Record
- **GIVEN** A `tool_use` whose helper raises an exception
- **WHEN** Clawndom dispatches the tool call
- **THEN** An audit record MUST be written with `error_summary` populated and `result_summary` empty or null

#### Scenario: Audit Log Is Separate From Operational Log
- **GIVEN** Clawndom is running with default configuration
- **WHEN** Both operational events and tool invocations occur
- **THEN** Operational log entries MUST NOT appear in the audit log file, and audit records MUST NOT appear in the operational log file

### Requirement: Credential Redaction In Audit Records

Before writing an audit record, the audit subsystem MUST redact every resolved credential value from the record's `args` field. Redaction MUST replace each occurrence of a credential value (exact string match) with the literal string `<redacted>`. Redaction applies to nested structures (objects, arrays). Non-matching values MUST be preserved unchanged.

This is belt-and-suspenders: credentials SHOULD never appear in `args` (they are injected by the executor at call time, not by the agent), but the redaction step is required as defense against misconfigured tools that accidentally accept credentials as arguments.

#### Scenario: Credential Value Redacted In Args
- **GIVEN** A misconfigured tool whose schema accepts `bot_token` as an arg and an agent that passes a value matching a resolved credential
- **WHEN** The audit record is written
- **THEN** The `args.bot_token` field MUST be the literal string `<redacted>`; the resolved credential value MUST NOT appear anywhere in the record

#### Scenario: Unrelated Strings Preserved
- **GIVEN** An audit record whose `args` contains a string that happens NOT to match any resolved credential
- **WHEN** The record is written
- **THEN** The non-matching string MUST be preserved unchanged

### Requirement: Audit Emission Through Single Function

All audit-record emissions MUST flow through a single function (`writeAuditRecord(record: AuditRecord): Promise<void>`) exported from `src/lib/audit/emit.ts`. The executor MUST NOT write to the audit log file directly. This single-function seam is a forward-compatibility hook for the unified logging framework (covered in a separate change) which will subsume this emitter without requiring executor changes.

#### Scenario: Executor Does Not Write Audit Log Directly
- **GIVEN** Clawndom source code
- **WHEN** The audit-emission code path is reviewed
- **THEN** Every audit record write MUST be a call to `writeAuditRecord`; no other source location writes to the audit log file
