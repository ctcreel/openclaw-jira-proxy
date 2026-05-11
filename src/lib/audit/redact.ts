/**
 * Replace every occurrence of a resolved credential value in the input with
 * the literal `<redacted>` string. Walks nested objects and arrays
 * recursively. Non-matching values are preserved unchanged.
 *
 * Credentials should not appear in `args` to begin with — the executor injects
 * them as kwargs, not as agent-emitted tool_use input — but this is
 * belt-and-suspenders against a misconfigured tool that accepts a credential
 * as an argument.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/observability/spec.md`,
 * Requirement: Credential Redaction In Audit Records.
 */
export function redactCredentials(input: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return input;
  const secretSet = new Set(secrets.filter((s) => s.length > 0));
  return redactValue(input, secretSet);
}

const REDACTED = '<redacted>';

function redactValue(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === 'string') {
    return secrets.has(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, secrets);
    }
    return out;
  }
  return value;
}
