/**
 * Per-tool-invocation audit record. One record written per `tool_use` block
 * dispatched through the executor.
 *
 * `correlation_id` defaults to `request_id` until SPE-2079 introduces real
 * correlation propagation through the request handling chain. The field is
 * shipped now so audit consumers (test fixtures, future SIEM forwarders)
 * don't have to handle pre-vs-post-SPE-2079 records differently.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/observability/spec.md`.
 */
export interface AuditRecord {
  readonly timestamp: string; // ISO 8601 UTC
  readonly agent_id: string;
  readonly route_id: string;
  readonly tool_name: string;
  readonly args: unknown; // post-redaction
  readonly result_summary: unknown | null;
  readonly error_summary: string | null;
  readonly latency_ms: number;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly agent_version: string;
}
