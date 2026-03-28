import type { RoutingRule, RoutingStrategy } from './types';
import { resolveFieldPath } from './field-path';

function matchesPattern(resolved: unknown, pattern: RegExp): boolean {
  if (Array.isArray(resolved)) {
    return resolved.some((element) => pattern.test(String(element)));
  }
  return pattern.test(String(resolved));
}

export const regexStrategy: RoutingStrategy = {
  name: 'regex',

  evaluate(payload: unknown, rule: RoutingRule): string | null {
    if (!rule.field || !rule.pattern) {
      return null;
    }

    const resolved = resolveFieldPath(payload, rule.field);
    if (resolved === undefined) {
      return null;
    }

    const pattern = new RegExp(rule.pattern, rule.flags);
    return matchesPattern(resolved, pattern) ? rule.agentId : null;
  },
};
