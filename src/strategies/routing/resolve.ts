import { getLogger } from '../../lib/logging';
import { getRoutingStrategy } from './registry';
import type { RoutingConfig } from './types';

const logger = getLogger('routing');

/**
 * Resolve which agent should receive this webhook payload.
 *
 * Evaluation order:
 * 1. Routing rules in array order (first match wins)
 * 2. routing.default fallback
 * 3. globalDefault (OPENCLAW_AGENT_ID)
 * 4. null (no match — caller should skip forwarding)
 */
export function resolveAgent(
  payload: unknown,
  routing: RoutingConfig | undefined,
  globalDefault: string,
): string | null {
  if (!routing || routing.rules.length === 0) {
    if (routing?.default) {
      return routing.default;
    }
    return globalDefault || null;
  }

  for (const rule of routing.rules) {
    const strategy = getRoutingStrategy(rule.strategy);
    const agentId = strategy.evaluate(payload, rule);
    if (agentId !== null) {
      logger.debug({ strategy: rule.strategy, field: rule.field, agentId }, 'Routing rule matched');
      return agentId;
    }
  }

  if (routing.default) {
    logger.debug({ agentId: routing.default }, 'Using routing default');
    return routing.default;
  }

  if (globalDefault) {
    logger.debug({ agentId: globalDefault }, 'Using global default agent');
    return globalDefault;
  }

  logger.warn('routing:no-match — no routing rules matched and no default configured');
  return null;
}
