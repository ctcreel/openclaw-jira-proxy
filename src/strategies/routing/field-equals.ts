import type { RoutingRule, RoutingStrategy } from './types';
import { resolveFieldPath } from './field-path';

function matchesValue(resolved: unknown, target: string): boolean {
  if (Array.isArray(resolved)) {
    return resolved.some((element) => String(element) === target);
  }
  return String(resolved) === target;
}

export const fieldEqualsStrategy: RoutingStrategy = {
  name: 'field-equals',

  evaluate(payload: unknown, rule: RoutingRule): string | null {
    if (!rule.field || rule.value === undefined) {
      return null;
    }

    const resolved = resolveFieldPath(payload, rule.field);
    if (resolved === undefined) {
      return null;
    }

    return matchesValue(resolved, rule.value) ? rule.agentId : null;
  },
};
