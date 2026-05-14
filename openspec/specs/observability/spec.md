## Purpose

Defines the logging, metrics, and health check capabilities that clawndom MUST provide for production observability.
## Requirements
### Requirement: Structured Logging

The template MUST provide a logging system with:
- Factory function to create named logger instances
- One-time configuration at application startup
- Two output formats: JSON (production) and human-readable (development)
- Configuration via environment variables (LOG_LEVEL, LOG_FORMAT, SERVICE_NAME)
- Automatic inclusion of correlation ID in every log message
- Automatic inclusion of service name in every log message

#### Scenario: JSON Log Output in Production
- **GIVEN** LOG_FORMAT is set to "json"
- **WHEN** A logger emits an info message
- **THEN** The output MUST be a single-line JSON object containing at minimum: timestamp, level, logger name, message, service name

#### Scenario: Correlation ID Propagation
- **GIVEN** A correlation ID has been set in the request context
- **WHEN** Any logger in the request lifecycle emits a message
- **THEN** The correlation ID MUST appear in the log output without explicit passing

### Requirement: Request Context

The template MUST provide request-scoped context storage that:
- Works in both synchronous and asynchronous code paths
- Stores correlation ID, request metadata, and arbitrary extra fields
- Provides generate, get, set, and clear operations for correlation ID
- Clears automatically at the end of each request to prevent leakage

#### Scenario: Context Isolation Between Requests
- **GIVEN** Two concurrent requests set different correlation IDs
- **WHEN** Each request logs a message
- **THEN** Each log MUST contain its own correlation ID, not the other request's

### Requirement: Runtime Adapters

The template MUST provide logging adapters for its target runtime environments:
- Lambda adapter: extracts AWS request ID as correlation ID, sets function metadata
- Web framework adapter: extracts correlation ID from request headers, logs request start/completion with timing

#### Scenario: Lambda Cold Start Logging
- **GIVEN** A Lambda function receives an invocation
- **WHEN** The Lambda adapter processes the event and context
- **THEN** The correlation ID MUST be set to the AWS request ID and function name/version MUST appear in all subsequent logs

### Requirement: Agent Run Prompt Observability

Every agent run MUST produce structured log entries that allow reconstruction of what was delivered to the runner. Two log entries MUST be emitted per run:

**At `info` level** (always emitted, safe for production):
- `jobId`: BullMQ job ID
- `provider`: provider name
- `runner`: runner type (e.g., "openclaw", "claude-cli")
- `sessionKey`: session key for correlation
- `promptHash`: first 12 hex chars of SHA-256 of the rendered prompt
- `promptLength`: character count of the rendered prompt
- Message: `"Agent run delivered"`

**At `debug` level** (emitted only when LOG_LEVEL=debug):
- All `info` fields
- `prompt`: the full rendered prompt as delivered
- Message: `"Agent run prompt"`

The `renderedPrompt` value MUST come from `RunResult.renderedPrompt` — the runner is the authoritative source for what was actually sent. This ensures that runner-level transformations (e.g., system prompt injection in the CLI runner) are captured accurately.

`promptHash` enables cross-referencing a specific prompt across log lines without storing the full content at info level.

#### Scenario: Production Logging Does Not Expose Payload
- **GIVEN** LOG_LEVEL=info (production default)
- **WHEN** An agent run completes
- **THEN** The log MUST include `promptHash` and `promptLength` but MUST NOT include the full prompt content

#### Scenario: Debug Logging Captures Full Prompt
- **GIVEN** LOG_LEVEL=debug
- **WHEN** An agent run completes
- **THEN** The log MUST include the full `prompt` field with the complete rendered content

#### Scenario: Hash Enables Correlation
- **GIVEN** A job log entry at info level with `promptHash: "a3f9c2b1e4d7"`
- **WHEN** The same session is re-run with the same template and payload
- **THEN** The resulting `promptHash` MUST be identical, confirming the same prompt was delivered

### Requirement: Template Preview Script

A `scripts/preview-template.ts` script MUST be provided for authoring-time template preview without invoking any runner or making any network calls.

The script MUST:
- Accept `--template <path>` (path to a Nunjucks template file)
- Accept `--payload <path>` (path to a JSON file containing a sample webhook payload)
- Render the template using the same `renderTemplate` function used at runtime
- Write the rendered output to stdout
- Exit non-zero if the template file or payload file cannot be read

A `make preview-template` target MUST be provided:
```makefile
preview-template:
	pnpm tsx scripts/preview-template.ts --template $(TEMPLATE) --payload $(PAYLOAD)
```

Sample payloads MAY be kept on disk (e.g., under `/tmp` or an ignored path) for repeatable preview runs; committing them is not required.

#### Scenario: Preview Renders Correctly
- **GIVEN** A Jira template referencing `{{ issue.key }}` and a sample payload with `issue.key: "SPE-100"`
- **WHEN** `make preview-template TEMPLATE=... PAYLOAD=/tmp/jira-issue-updated.json` is run
- **THEN** The output MUST contain `SPE-100` and exit 0

#### Scenario: Preview Fails on Missing File
- **GIVEN** The `--payload` argument points to a non-existent file
- **WHEN** The script runs
- **THEN** It MUST exit non-zero with a clear error message

### Requirement: Health Check Endpoint

The template MUST provide a health check endpoint at `/api/health` that returns:
- Overall status (healthy, degraded, unhealthy)
- Individual component check results
- Service version and environment
- Timestamp

Health checks MUST include one entry per registered runner that implements `isHealthy()`, named `runner:<type>` (e.g., `runner:openclaw`, `runner:claude-cli`). Runners that do not implement `isHealthy()` MUST NOT appear in health output.

Status aggregation:
- If Redis is down → `unhealthy` (503)
- If any runner or queue check is degraded but none unhealthy → `degraded` (200)
- All checks pass → `healthy` (200)

#### Scenario: Degraded Runner
- **GIVEN** The `claude-cli` runner's binary is not found on PATH
- **WHEN** The health endpoint is called
- **THEN** The response MUST show `runner:claude-cli` as `degraded` and overall status as `degraded`

#### Scenario: Runner Not Registered — No Check
- **GIVEN** No provider uses the `openclaw` runner and it is not registered
- **WHEN** The health endpoint is called
- **THEN** `runner:openclaw` MUST NOT appear in the health response

### Requirement: CloudWatch Metrics

The template MUST provide a metrics utility that:
- Supports standard CloudWatch metric units (Count, Milliseconds, Bytes, Percent, etc.)
- Handles batching (up to 1000 metrics per API call)
- Gracefully degrades when the AWS SDK is not available (log warning, don't crash)
- Provides a factory function for creating metric data points

#### Scenario: Metrics Without AWS SDK
- **GIVEN** The @aws-sdk/client-cloudwatch package is not installed
- **WHEN** Code attempts to publish a metric
- **THEN** The function MUST log a warning and return without error

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

