import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { ProviderConfig } from '../../src/config';
import { SecretManager } from '../../src/secrets/manager';
import { validateProviderEnvSecrets } from '../../src/secrets/validate-env-secrets';
import { buildMockSecretManager } from '../helpers/mock-secret-manager';

const baseProvider: ProviderConfig = {
  name: 'jira',
  transport: 'webhook',
  routePath: '/hooks/jira',
  hmacSecret: 'test-hmac',
  signatureStrategy: 'websub',
};

describe('validateProviderEnvSecrets', () => {
  let manager: SecretManager | null = null;

  beforeEach(() => {
    manager = null;
  });

  afterEach(() => {
    if (manager) manager.close();
  });

  it('is a no-op when no provider declares envSecrets', async () => {
    manager = await buildMockSecretManager([]);
    expect(() => validateProviderEnvSecrets([baseProvider], manager!)).not.toThrow();
  });

  it('succeeds when every declared key is known to SecretManager', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok']]);
    const provider: ProviderConfig = { ...baseProvider, envSecrets: ['jira_patch_token'] };
    expect(() => validateProviderEnvSecrets([provider], manager!)).not.toThrow();
  });

  it('throws when any declared key is not known to SecretManager', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok']]);
    const provider: ProviderConfig = {
      ...baseProvider,
      envSecrets: ['jira_patch_token', 'missing_key'],
    };
    expect(() => validateProviderEnvSecrets([provider], manager!)).toThrow(/jira:missing_key/);
  });

  it('aggregates all missing keys across providers into one error', async () => {
    manager = await buildMockSecretManager([['known_key', 'x']]);
    const providerA: ProviderConfig = {
      ...baseProvider,
      name: 'a',
      envSecrets: ['missing_a'],
    };
    const providerB: ProviderConfig = {
      ...baseProvider,
      name: 'b',
      envSecrets: ['missing_b'],
    };
    expect(() => validateProviderEnvSecrets([providerA, providerB], manager!)).toThrow(
      /a:missing_a.*b:missing_b/,
    );
  });
});
