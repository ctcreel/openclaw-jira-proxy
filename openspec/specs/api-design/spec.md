## Purpose

Defines the API design standards for all Sc0red services to ensure consistent, predictable API contracts across the platform.

## Requirements

### Requirement: Response Envelope

All API responses MUST follow a consistent structure. Success responses MUST return the resource or collection directly with appropriate HTTP status codes (200, 201, 204). Error responses MUST follow RFC 7807 Problem Details format with type, title, status, detail, and optional context fields.

#### Scenario: Successful Resource Creation
- **GIVEN** A client sends a valid POST request to create a resource
- **WHEN** The resource is created successfully
- **THEN** The API MUST respond with HTTP 201 and the created resource in the body

#### Scenario: Validation Error
- **GIVEN** A client sends a POST request with invalid data
- **WHEN** Validation fails at the boundary
- **THEN** The API MUST respond with HTTP 400 and an RFC 7807 body including the error code, detail message, and field-level context

### Requirement: Input Validation at Boundary

All API endpoints MUST validate request input using schema validation (Zod in TypeScript, Pydantic in Python) at the handler/route level. Validation MUST occur before any business logic executes. Invalid requests MUST return immediately with a descriptive error — they MUST NOT propagate into service or domain layers.

#### Scenario: Missing Required Field
- **GIVEN** A client sends a request missing a required field
- **WHEN** The schema validation runs at the boundary
- **THEN** The API MUST return HTTP 400 with the field name and validation rule in the error context

### Requirement: Pagination

List endpoints that may return large result sets MUST support pagination. Cursor-based pagination MUST be used (not offset-based) for consistency and performance. The response MUST include a `nextCursor` field (null if no more results) and the client MUST pass `cursor` as a query parameter to fetch the next page.

#### Scenario: First Page Request
- **GIVEN** A client requests a list endpoint without a cursor parameter
- **WHEN** There are more results than fit in one page
- **THEN** The response MUST include the first page of results and a non-null `nextCursor` value

### Requirement: Security Headers

All HTTP responses MUST include appropriate security headers. At minimum: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security` (HTTPS environments). CORS policy MUST be explicitly configured — never use `Access-Control-Allow-Origin: *` in production.

#### Scenario: Response Missing Security Headers
- **GIVEN** An API endpoint returns a response
- **WHEN** The response headers are inspected
- **THEN** X-Content-Type-Options and X-Frame-Options MUST be present
