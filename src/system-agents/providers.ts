import { dirname, join } from 'node:path';

import { getSettings, type ProviderConfig, type WebhookProviderConfig } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('system-agent-providers');

/**
 * Runner config stamped onto Builder's auto-injected providers. Inherits
 * `type`, `binary`, and `systemPrompt` from a workspace-agent provider so
 * Builder runs on whatever runner the operator already provisions — no
 * separate openclaw/claude-cli/openai decision for system agents.
 * `workDirectory` is overridden to a system-agent scratch root (sibling
 * of `configDir`) and `workDirectoryStrategy` is forced to `per-dispatch`
 * so each dispatch gets a fresh tree to clone the target repo into.
 */
interface SystemAgentRunnerConfig {
  readonly type: 'claude-cli';
  readonly workDirectory: string;
  readonly workDirectoryStrategy: 'per-dispatch';
  readonly binary?: string;
  readonly systemPrompt?: string;
}

/**
 * Find a claude-cli runner config in the operator's existing providers
 * to inherit `binary`/`systemPrompt` from. Returns `undefined` when no
 * claude-cli provider exists — Builder can't run without one.
 */
function findInheritableClaudeCliRunner(
  providers: readonly ProviderConfig[],
): { binary?: string; systemPrompt?: string } | undefined {
  for (const provider of providers) {
    if (provider.runner?.type === 'claude-cli') {
      const inherited: { binary?: string; systemPrompt?: string } = {};
      if (provider.runner.binary !== undefined) inherited.binary = provider.runner.binary;
      if (provider.runner.systemPrompt !== undefined) {
        inherited.systemPrompt = provider.runner.systemPrompt;
      }
      return inherited;
    }
  }
  return undefined;
}

/**
 * Build the runner config Builder stamps onto her providers. Scratch root
 * is `<dirname(configDir)>/system-agents/builder` so it sits alongside the
 * `agents/` clone tree without mixing the two. The directory is created
 * lazily by the worker before each dispatch — no boot-time mkdir needed.
 */
function buildBuilderRunnerConfig(
  inherited: { binary?: string; systemPrompt?: string },
  configDir: string,
): SystemAgentRunnerConfig {
  const config: SystemAgentRunnerConfig = {
    type: 'claude-cli',
    workDirectory: join(dirname(configDir), 'system-agents', 'builder'),
    workDirectoryStrategy: 'per-dispatch',
    ...(inherited.binary === undefined ? {} : { binary: inherited.binary }),
    ...(inherited.systemPrompt === undefined ? {} : { systemPrompt: inherited.systemPrompt }),
  };
  return config;
}

/**
 * Builder's dispatch provider config. Uses the same `CLAWNDOM_AGENT_TOKEN`
 * the existing internal-tool API (`/api/tasks`) already authenticates
 * with, so opted-in agents that already wield `dispatch_task` need no
 * new secret to also wield `dispatch_to_builder`. One bearer per
 * clawndom instance covers every internal-tool surface.
 */
export function buildBuilderDispatchProvider(
  agentToken: string,
  runner: SystemAgentRunnerConfig,
): WebhookProviderConfig {
  return {
    name: 'builder-dispatch',
    transport: 'webhook',
    routePath: '/webhooks/system/builder',
    signatureStrategy: 'bearer',
    hmacSecret: agentToken,
    runner,
  };
}

export function buildBuilderCallbackProvider(
  agentToken: string,
  runner: SystemAgentRunnerConfig,
): WebhookProviderConfig {
  return {
    name: 'builder-callback',
    transport: 'webhook',
    routePath: '/webhooks/builder-callback',
    signatureStrategy: 'bearer',
    hmacSecret: agentToken,
    runner,
  };
}

/**
 * Auto-injected webhook providers contributed by bundled system agents.
 * Fail-soft on two missing prerequisites:
 *   - `CLAWNDOM_AGENT_TOKEN` not set — same bearer used by `/api/tasks`,
 *     so its absence is a serious deploy gap; skip and warn.
 *   - No claude-cli runner in `PROVIDERS_CONFIG` — Builder inherits her
 *     runner from a workspace agent, so without one there's nothing to
 *     stamp; skip and warn.
 * In both cases Builder is dormant for the boot; workspace agents are
 * unaffected.
 */
export function buildSystemAgentProviders(): readonly WebhookProviderConfig[] {
  const settings = getSettings();
  const agentToken = settings.agentToken;
  if (!agentToken) {
    logger.warn(
      'CLAWNDOM_AGENT_TOKEN not configured; skipping system-agent provider injection. Builder dormant until the token is set.',
    );
    return [];
  }
  const inherited = findInheritableClaudeCliRunner(settings.providers);
  if (inherited === undefined) {
    logger.warn(
      'No claude-cli provider in PROVIDERS_CONFIG; Builder needs an inheritable runner. Builder dormant.',
    );
    return [];
  }
  const runner = buildBuilderRunnerConfig(inherited, settings.configDir);
  return [
    buildBuilderDispatchProvider(agentToken, runner),
    buildBuilderCallbackProvider(agentToken, runner),
  ];
}
