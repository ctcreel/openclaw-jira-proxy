## Purpose

Defines the structured error handling patterns that every Sc0red service MUST implement for consistent API responses and debugging.

## Requirements

### Requirement: Exception Hierarchy

The template MUST provide a base error class (Sc0redError) with:
- Error code (machine-readable string, e.g., "VALIDATION_ERROR")
- HTTP status code mapping
- Context dictionary for debugging information
- Serialization to API response format (toDict)
- Serialization to structured log format (toLogDict)
- Registry pattern for reverse lookup by error code

Client errors (4xx) MUST include at minimum: ValidationError, NotFoundError, ConflictError, AuthenticationError, AuthorizationError, RateLimitError, BadRequestError.

Server errors (5xx) MUST include at minimum: ProcessingError, ExternalServiceError, DatabaseError, ConfigurationError, ServiceUnavailableError, OperationTimeoutError.

#### Scenario: Error Code Lookup
- **GIVEN** An error with code "NOT_FOUND" has been registered
- **WHEN** Code calls getByErrorCode("NOT_FOUND")
- **THEN** The NotFoundError class MUST be returned

#### Scenario: Structured Error Response
- **GIVEN** A ValidationError is thrown with field and value context
- **WHEN** The error is serialized to an API response
- **THEN** The response MUST contain errorCode, message, and context fields

### Requirement: Retry Utility

The template MUST provide a retry decorator/wrapper with:
- Configurable maximum attempts, base delay, max delay, and exponential base
- Exponential backoff with jitter (plus/minus 25%) to prevent thundering herd
- Configurable list of retryable exception types
- Optional callback on each retry attempt
- RetryExhaustedError when all attempts fail (includes attempt count and last exception)

#### Scenario: Transient Failure Recovery
- **GIVEN** A function fails twice with a retryable error then succeeds
- **WHEN** The function is called with retry configured for 3 max attempts
- **THEN** The function MUST return the successful result on the third attempt

#### Scenario: Non-Retryable Error
- **GIVEN** A function throws a non-retryable error
- **WHEN** The retry wrapper catches it
- **THEN** The error MUST be re-thrown immediately without retry

### Requirement: TTL Cache

The template MUST provide a time-to-live cache utility with:
- Get/set/clear operations
- Automatic expiration of entries
- Optional maximum size with oldest-entry eviction
- Cache statistics (hits, misses, expirations, evictions)
- Hit rate calculation

#### Scenario: Cache Expiration
- **GIVEN** A value is cached with a 60-second TTL
- **WHEN** The value is requested after 61 seconds
- **THEN** The cache MUST return a miss and increment the expirations counter

### Requirement: Error Boundary Placement

Errors MUST be caught at defined boundaries only: request handlers, queue processors, scheduled job entry points, and top-level orchestrators. Internal business logic MUST NOT catch and suppress errors — errors MUST propagate up to the boundary. The only exception is "catch, add context, and rethrow" to attach debugging information. Blanket try/catch blocks in internal code MUST be forbidden.

#### Scenario: Internal Try-Catch Suppression
- **GIVEN** A service function wraps its logic in a try/catch that returns a default value on error
- **WHEN** Code review runs
- **THEN** The reviewer MUST flag it as a violation — the error should propagate to the handler boundary

#### Scenario: Contextual Rethrow
- **GIVEN** A service function catches an error, adds context (operation name, entity ID), and rethrows
- **WHEN** Code review runs
- **THEN** This MUST be accepted as valid error handling
