/**
 * Workspace-audit types — shared between the rule implementations and the CLI.
 *
 * Severity tiers:
 *   - "error"   — the workspace will not work as configured. Runtime would either
 *                 crash at startup or fail the first time the rule fires.
 *                 Examples: messageTemplate path missing, tool referenced in
 *                 template prose isn't declared on the route, injected doc
 *                 contains a literal `{{` (Nunjucks render breaks).
 *   - "warning" — works today but matches a legacy pattern the workspace was
 *                 supposed to retire. Examples: memory/<file>.md log writes in
 *                 a SPE-2078 workspace, `mcp__claude_ai_*` MCP names that no
 *                 longer resolve on production hosts.
 *
 * Auditors return zero-to-many findings; the CLI exits non-zero when any
 * "error" finding is present.
 */
export type AuditSeverity = 'error' | 'warning';

export interface AuditFinding {
  readonly severity: AuditSeverity;
  /** Stable identifier (e.g. "missing-template", "undeclared-tool"). Used for output sorting + future suppression directives. */
  readonly rule: string;
  /** Short single-sentence description. */
  readonly message: string;
  /** Optional file path the finding applies to, relative to agentDir. */
  readonly path?: string;
  /** Optional 1-indexed line number inside `path`. */
  readonly line?: number;
  /** Optional remediation hint. */
  readonly hint?: string;
}

export interface AuditReport {
  readonly agentDir: string;
  readonly findings: readonly AuditFinding[];
}

export function getCountsBySeverity(
  findings: readonly AuditFinding[],
): Record<AuditSeverity, number> {
  return findings.reduce(
    (acc, finding) => {
      acc[finding.severity] += 1;
      return acc;
    },
    { error: 0, warning: 0 } as Record<AuditSeverity, number>,
  );
}
