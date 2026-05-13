import type { AuditConfig } from './load-config';

/**
 * Read the literal string `condition.equals.value` when the condition's
 * `equals.field` matches the requested field name. Returns `undefined`
 * for non-equals conditions or fields that don't match — those are
 * structurally valid but not what the caller is asking about.
 */
export function extractEqualsValue(condition: unknown, field: string): string | undefined {
  const equals = (condition as { equals?: { field: string; value: string } } | undefined)?.equals;
  if (equals === undefined || equals.field !== field) return undefined;
  return equals.value;
}

/**
 * Map every `routing.internal` rule keyed by the `taskType` it answers to.
 * Used by both the dispatch-declaration audit (to verify dispatch targets
 * exist) and the graph renderer (to draw dispatch edges).
 */
export function collectInternalTaskTargets<T>(
  config: AuditConfig,
  visit: (rule: AuditConfig['routing'][string]['rules'][number], index: number) => T,
): Map<string, T> {
  const out = new Map<string, T>();
  const internal = config.routing['internal'];
  if (internal === undefined) return out;
  for (let i = 0; i < internal.rules.length; i += 1) {
    const rule = internal.rules[i] as AuditConfig['routing'][string]['rules'][number];
    const taskType = extractEqualsValue(rule.condition, 'taskType');
    if (taskType !== undefined) {
      out.set(taskType, visit(rule, i));
    }
  }
  return out;
}

/**
 * Run `regex` (must be a global regex with one capture group) line-by-line
 * over `source`, yielding each unique `[capture, lineNumber]` pair. Returns
 * 1-based line numbers so findings line up with editor reporting.
 */
export function collectCaptures(source: string, regex: RegExp): Array<readonly [string, number]> {
  const out: Array<readonly [string, number]> = [];
  const seen = new Set<string>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const capture = match[1] as string;
      const key = `${capture}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([capture, i + 1] as const);
    }
  }
  return out;
}
