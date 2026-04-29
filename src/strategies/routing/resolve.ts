import { getLogger } from '../../lib/logging';
import type { AgentRule, ResolvedAgent } from '../../services/agent-loader.service';
import { evaluateCondition } from './condition';

const logger = getLogger('routing');

export interface ResolvedRoute {
  agentId: string;
  agentDir: string;
  messageTemplate?: string;
  /** The matched rule itself — exposes session config and any future per-rule fields. */
  rule: AgentRule;
}

/**
 * Walk the configured agents in order; for each agent, evaluate its routing
 * rules for this provider. First match wins. No match returns null — the
 * caller logs `routing:no-match` and skips forwarding.
 */
export function resolveAgentFromAgents(
  payload: unknown,
  providerName: string,
  agents: readonly ResolvedAgent[],
): ResolvedRoute | null {
  for (const agent of agents) {
    const providerRouting = agent.config.routing[providerName];
    if (providerRouting === undefined) {
      continue;
    }
    for (const rule of providerRouting.rules) {
      // Provider-routed rules (jira, slack, internal) require a
      // condition. routing.schedule rules don't — they're cron-driven.
      // A rule without a condition can't match a payload here, skip.
      if (!rule.condition) continue;
      if (evaluateCondition(payload, rule.condition)) {
        logger.debug({ agentId: agent.name, rule: rule.name }, 'Routing rule matched');
        return {
          agentId: agent.name,
          agentDir: agent.dir,
          messageTemplate: rule.messageTemplate,
          rule,
        };
      }
    }
  }
  logger.warn({ providerName }, 'routing:no-match — no agent rule matched');
  return null;
}
