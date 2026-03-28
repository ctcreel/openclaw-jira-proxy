import type { RoutingRule, RoutingStrategy } from './types';

export const defaultStrategy: RoutingStrategy = {
  name: 'default',

  evaluate(_payload: unknown, rule: RoutingRule): string | null {
    return rule.agentId;
  },
};
