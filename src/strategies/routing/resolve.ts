import { getLogger } from '../../lib/logging';
import { getRoutingStrategy } from './registry';
import type { RoutingConfig } from './types';

const logger = getLogger('routing');

export interface ResolvedRoute {
  agentId: string;
  messageTemplate?: string;
}

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
): ResolvedRoute | null {
  if (!routing || routing.rules.length === 0) {
    if (routing?.default) {
      return { agentId: routing.default };
    }
    return globalDefault ? { agentId: globalDefault } : null;
  }

  for (const rule of routing.rules) {
    const strategy = getRoutingStrategy(rule.strategy);
    const agentId = strategy.evaluate(payload, rule);
    if (agentId !== null) {
      logger.debug({ strategy: rule.strategy, field: rule.field, agentId }, 'Routing rule matched');
      return { agentId, messageTemplate: rule.messageTemplate };
    }
  }

  if (routing.default) {
    logger.debug({ agentId: routing.default }, 'Using routing default');
    return { agentId: routing.default };
  }

  // If routing.default is explicitly null, skip the global fallback
  if (routing.default === null) {
    logger.debug('routing:no-match — routing.default is null, skipping global fallback');
    return null;
  }

  if (globalDefault) {
    logger.debug({ agentId: globalDefault }, 'Using global default agent');
    return { agentId: globalDefault };
  }

  logger.warn('routing:no-match — no routing rules matched and no default configured');
  return null;
}
