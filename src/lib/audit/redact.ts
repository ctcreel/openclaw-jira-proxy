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
// noqa: NAMING001
export function redactCredentials(input: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return input;
  // Sort longest-first so a short secret that happens to be a prefix of
  // a longer one doesn't half-redact and leak the tail of the longer
  // value.
  const ordered = [...new Set(secrets.filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (ordered.length === 0) return input;
  return applyRedaction(input, ordered);
}

const REDACTED = '<redacted>';

// noqa: NAMING001
function applyRedaction(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyRedaction(item, secrets));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyRedaction(v, secrets);
    }
    return out;
  }
  return value;
}
