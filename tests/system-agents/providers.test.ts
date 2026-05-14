import { describe, it, expect } from 'vitest';

import type { SecretManager } from '../../src/secrets/manager';
import {
  BUILDER_INTERNAL_BEARER_SECRET_KEY,
  buildBuilderCallbackProvider,
  buildBuilderDispatchProvider,
  buildSystemAgentProviders,
} from '../../src/system-agents/providers';

function makeSecretManager(token: string): SecretManager {
  return {
    getSecret: (key: string) => {
      if (key !== BUILDER_INTERNAL_BEARER_SECRET_KEY) {
        throw new Error(`Unexpected secret key in test fake: ${key}`);
      }
      return token;
    },
  } as unknown as SecretManager;
}

describe('system-agent providers', () => {
  const secrets = makeSecretManager('test-bearer-token');

  it('builds Builder dispatch provider at /webhooks/system/builder', () => {
    const provider = buildBuilderDispatchProvider(secrets);
    expect(provider.name).toBe('builder-dispatch');
    expect(provider.transport).toBe('webhook');
    expect(provider.routePath).toBe('/webhooks/system/builder');
    expect(provider.signatureStrategy).toBe('bearer');
    expect(provider.hmacSecret).toBe('test-bearer-token');
  });

  it('builds Builder callback provider at /webhooks/builder-callback', () => {
    const provider = buildBuilderCallbackProvider(secrets);
    expect(provider.name).toBe('builder-callback');
    expect(provider.routePath).toBe('/webhooks/builder-callback');
    expect(provider.signatureStrategy).toBe('bearer');
    expect(provider.hmacSecret).toBe('test-bearer-token');
  });

  it('buildSystemAgentProviders returns dispatch and callback', () => {
    const providers = buildSystemAgentProviders(secrets);
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.name)).toEqual(['builder-dispatch', 'builder-callback']);
  });

  it('every provider in the bundle uses the bearer strategy', () => {
    for (const provider of buildSystemAgentProviders(secrets)) {
      expect(provider.signatureStrategy).toBe('bearer');
    }
  });
});
