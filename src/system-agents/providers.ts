import type { WebhookProviderConfig } from '../config';
import { getLogger } from '../lib/logging';
import type { SecretManager } from '../secrets/manager';

const logger = getLogger('system-agent-providers');

/**
 * Logical secret key holding the shared bearer token that opted-in agents
 * use to authenticate calls to system-agent routes. Configured via
 * SECRETS_CONFIG; the system-agent provider injection resolves it eagerly
 * at startup so the existing webhook handler sees `hmacSecret` populated.
 */
export const BUILDER_INTERNAL_BEARER_SECRET_KEY = 'builder_internal_bearer';

/**
 * Builder's dispatch provider config. The runtime adds this to
 * `settings.providers` once Builder's clawndom.yaml is loaded, so the
 * existing webhook → queue → worker → runner chain picks her dispatch up
 * the same way it picks up Jira or GitHub events. The route, queue, and
 * worker are all provided by the existing machinery — only the provider
 * entry is new.
 */
export function buildBuilderDispatchProvider(secretManager: SecretManager): WebhookProviderConfig {
  return {
    name: 'builder-dispatch',
    transport: 'webhook',
    routePath: '/webhooks/system/builder',
    signatureStrategy: 'bearer',
    hmacSecret: secretManager.getSecret(BUILDER_INTERNAL_BEARER_SECRET_KEY),
  };
}

/**
 * Builder's callback provider config. Builder POSTs lifecycle state
 * transitions here; the request fans out through the standard ingestion
 * path so each opted-in dispatching agent's `routing.builder-callback`
 * rules can match its own callbacks by `agent_name` and render a
 * reply template using the echoed reply-context envelope.
 */
export function buildBuilderCallbackProvider(secretManager: SecretManager): WebhookProviderConfig {
  return {
    name: 'builder-callback',
    transport: 'webhook',
    routePath: '/webhooks/builder-callback',
    signatureStrategy: 'bearer',
    hmacSecret: secretManager.getSecret(BUILDER_INTERNAL_BEARER_SECRET_KEY),
  };
}

/**
 * All auto-injected webhook providers contributed by bundled system
 * agents. Today that's Builder's dispatch and callback routes; future
 * system agents add their entries here. The deploy-complete admin
 * route is wired separately in routes/index.ts because it doesn't fan
 * out to agents — it synthesizes a callback POST internally.
 *
 * Fail-soft: if `BUILDER_INTERNAL_BEARER` is not bound in SECRETS_CONFIG,
 * the auto-injected providers are skipped and Builder is dormant for
 * this boot. The rest of clawndom comes up normally. A startup-blocking
 * "fail closed" check here would mean every host that hasn't run the
 * Builder onboarding recipe yet can't boot — that's a worse failure
 * mode than "Builder doesn't route until you finish onboarding."
 *
 * The warning log is the operator's signal that Builder needs the
 * SECRETS_CONFIG binding before any dispatching agent can reach her.
 */
export function buildSystemAgentProviders(
  secretManager: SecretManager,
): readonly WebhookProviderConfig[] {
  if (!secretManager.hasSecret(BUILDER_INTERNAL_BEARER_SECRET_KEY)) {
    logger.warn(
      { key: BUILDER_INTERNAL_BEARER_SECRET_KEY },
      'Builder bearer secret not configured; skipping system-agent provider injection. Run docs/builder-onboarding.md to provision.',
    );
    return [];
  }
  return [buildBuilderDispatchProvider(secretManager), buildBuilderCallbackProvider(secretManager)];
}
