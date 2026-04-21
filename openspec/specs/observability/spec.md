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
