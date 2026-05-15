import { getSettings, type WebhookProviderConfig } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('system-agent-providers');

/**
 * Builder's dispatch provider config. Uses the same `CLAWNDOM_AGENT_TOKEN`
 * the existing internal-tool API (`/api/tasks`) already authenticates
 * with, so opted-in agents that already wield `dispatch_task` need no
 * new secret to also wield `dispatch_to_builder`. One bearer per
 * clawndom instance covers every internal-tool surface.
 */
export function buildBuilderDispatchProvider(agentToken: string): WebhookProviderConfig {
  return {
    name: 'builder-dispatch',
    transport: 'webhook',
    routePath: '/webhooks/system/builder',
    signatureStrategy: 'bearer',
    hmacSecret: agentToken,
  };
}

export function buildBuilderCallbackProvider(agentToken: string): WebhookProviderConfig {
  return {
    name: 'builder-callback',
    transport: 'webhook',
    routePath: '/webhooks/builder-callback',
    signatureStrategy: 'bearer',
    hmacSecret: agentToken,
  };
}

/**
 * Auto-injected webhook providers contributed by bundled system agents.
 * Fail-soft: if `CLAWNDOM_AGENT_TOKEN` isn't configured (which is itself
 * a serious deploy gap — `/api/tasks` would also be broken), skip the
 * injection and log a warning. Builder dormant for this boot.
 */
export function buildSystemAgentProviders(): readonly WebhookProviderConfig[] {
  const agentToken = getSettings().agentToken;
  if (!agentToken) {
    logger.warn(
      'CLAWNDOM_AGENT_TOKEN not configured; skipping system-agent provider injection. Builder dormant until the token is set.',
    );
    return [];
  }
  return [buildBuilderDispatchProvider(agentToken), buildBuilderCallbackProvider(agentToken)];
}
