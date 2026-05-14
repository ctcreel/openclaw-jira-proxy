import type { AgentEntry } from '../../config';
import type { SecretManager } from '../../secrets/manager';
import { isOptedInToBuilder, validateBuilderAgentFields } from './agent-config';

/**
 * Fail fast at startup if any opted-in agent declares a `builderBotRef`
 * that SecretManager doesn't know about — surfacing a typo or missing
 * SECRETS_CONFIG entry now beats discovering it when an operator fires
 * a Builder dispatch hours later. Also enforces the cross-field rule
 * "if you opt in, declare the full triple" — Zod's optional triple can't
 * express it on its own.
 */
export function validateBuilderAgentSecrets(
  agents: readonly AgentEntry[],
  secretManager: SecretManager,
): void {
  const missing: Array<{ agent: string; key: string }> = [];
  for (const agent of agents) {
    validateBuilderAgentFields(agent.name, agent);
    if (!isOptedInToBuilder(agent)) continue;
    if (agent.builderBotRef === undefined) continue;
    if (!secretManager.hasSecret(agent.builderBotRef)) {
      missing.push({ agent: agent.name, key: agent.builderBotRef });
    }
  }
  if (missing.length > 0) {
    const details = missing.map((entry) => `${entry.agent}:${entry.key}`).join(', ');
    throw new Error(
      `Agent builderBotRef references undeclared secret keys (add them to SECRETS_CONFIG): ${details}`,
    );
  }
}
