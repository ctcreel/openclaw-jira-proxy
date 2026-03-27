## Purpose

Defines the logging, metrics, and health check capabilities that every Sc0red service MUST provide for production observability.

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

### Requirement: Health Check Endpoint

The template MUST provide a health check endpoint at `/api/health` or equivalent that returns:
- Overall status (healthy, degraded, unhealthy)
- Individual component check results
- Service version and environment
- Timestamp

Status aggregation: if any component is unhealthy, overall status MUST be unhealthy. If any component is degraded but none unhealthy, overall status MUST be degraded.

#### Scenario: Degraded Dependency
- **GIVEN** The application component is healthy but the database component is degraded
- **WHEN** The health endpoint is called
- **THEN** The response MUST show overall status as "degraded" with individual component statuses

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
