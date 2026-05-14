import { describe, it, expect } from 'vitest';

import type { AgentEntry } from '../../../src/config';
import type { SecretManager } from '../../../src/secrets/manager';
import { validateBuilderAgentSecrets } from '../../../src/system-agents/builder/validate-secrets';

function makeSecretManager(knownKeys: readonly string[]): SecretManager {
  const known = new Set(knownKeys);
  return { hasSecret: (key: string) => known.has(key) } as unknown as SecretManager;
}

function makeAgent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    name: overrides.name ?? 'agent',
    repo: overrides.repo ?? 'git@github.com:org/the-agency.git',
    ...overrides,
  } as AgentEntry;
}

describe('validateBuilderAgentSecrets', () => {
  it('passes when no agents are opted in', () => {
    const agents = [makeAgent({ name: 'patch' }), makeAgent({ name: 'scarlett' })];
    const secrets = makeSecretManager([]);
    expect(() => validateBuilderAgentSecrets(agents, secrets)).not.toThrow();
  });

  it('passes when an opted-in agent has a known builderBotRef and full triple', () => {
    const agents = [
      makeAgent({
        name: 'winston',
        builderBotRef: 'builder_bot_the_agency',
        operatorAllowlist: ['heather@example.com'],
        testableMechanism: { type: 'cache_refresh' },
      }),
    ];
    const secrets = makeSecretManager(['builder_bot_the_agency']);
    expect(() => validateBuilderAgentSecrets(agents, secrets)).not.toThrow();
  });

  it('throws when an opted-in agent references an unknown secret key', () => {
    const agents = [
      makeAgent({
        name: 'winston',
        builderBotRef: 'missing_key',
        operatorAllowlist: [],
        testableMechanism: { type: 'cache_refresh' },
      }),
    ];
    const secrets = makeSecretManager([]);
    expect(() => validateBuilderAgentSecrets(agents, secrets)).toThrow(/winston:missing_key/);
  });

  it('aggregates multiple missing keys into one error', () => {
    const agents = [
      makeAgent({
        name: 'winston',
        builderBotRef: 'missing_a',
        operatorAllowlist: [],
        testableMechanism: { type: 'cache_refresh' },
      }),
      makeAgent({
        name: 'heather-helper',
        builderBotRef: 'missing_b',
        operatorAllowlist: [],
        testableMechanism: { type: 'cache_refresh' },
      }),
    ];
    const secrets = makeSecretManager([]);
    expect(() => validateBuilderAgentSecrets(agents, secrets)).toThrow(
      /winston:missing_a.*heather-helper:missing_b/,
    );
  });

  it('throws when opt-in is partial (builderBotRef set but allowlist missing)', () => {
    const agents = [
      makeAgent({
        name: 'winston',
        builderBotRef: 'k',
        testableMechanism: { type: 'cache_refresh' },
      }),
    ];
    const secrets = makeSecretManager(['k']);
    expect(() => validateBuilderAgentSecrets(agents, secrets)).toThrow(/operatorAllowlist/);
  });

  it('throws when opt-in is partial (builderBotRef set but testableMechanism missing)', () => {
    const agents = [
      makeAgent({
        name: 'winston',
        builderBotRef: 'k',
        operatorAllowlist: [],
      }),
    ];
    const secrets = makeSecretManager(['k']);
    expect(() => validateBuilderAgentSecrets(agents, secrets)).toThrow(/testableMechanism/);
  });
});
