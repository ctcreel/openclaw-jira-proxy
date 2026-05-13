import { resolveRuleId } from '../../services/rule-id';
import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Rule identity uniqueness.
 *
 * A rule's `id:` (explicit or defaulted from `name:`) is the stable key
 * sidecar files, editor cross-references, and audit findings use to
 * reference the rule. Two rules in the same provider sharing an id is
 * an unrecoverable ambiguity — every downstream lookup against that id
 * would silently pick the first one and ignore the second.
 *
 * Default-id collisions are the realistic failure mode: two rules
 * named "Triage Inbox" and "triage-inbox" slug to the same default id.
 * The fix is to add an explicit `id:` to one of them. The audit emits
 * an error (not a warning) because there's no good runtime behavior
 * when this happens.
 */
export function checkRuleIdUniqueness(config: AuditConfig): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const [providerName, routing] of Object.entries(config.routing)) {
    const seen = new Map<string, string>();
    for (let i = 0; i < routing.rules.length; i += 1) {
      const rule = routing.rules[i] as AuditConfig['routing'][string]['rules'][number];
      const id = resolveRuleId(rule, i);
      const previous = seen.get(id);
      if (previous !== undefined) {
        findings.push({
          severity: 'error',
          rule: 'duplicate-rule-id',
          message: `routing.${providerName} has two rules sharing id '${id}' (previously declared by '${previous}'). Add an explicit \`id:\` to one of them.`,
          path: 'clawndom.yaml',
          hint: 'Default ids are derived from `name:` as a kebab-case slug; collisions usually mean two rule names slugify identically. The explicit `id:` field overrides the default.',
        });
        continue;
      }
      seen.set(id, rule.name ?? id);
    }
  }

  return findings;
}
