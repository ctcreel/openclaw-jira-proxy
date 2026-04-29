import type { ProviderConfig } from '../../src/config';

/**
 * Build a minimal `ProviderConfig` fixture for tests. Defaults to a webhook
 * transport with the `slack` signature strategy; pass `overrides` to vary
 * `name`, `contextStrategy`, etc.
 *
 * The cast through `as ProviderConfig` skips the discriminated-union check
 * — fine for tests that don't exercise schema parsing.
 */
export function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'slack',
    transport: 'webhook',
    routePath: '/slack',
    signatureStrategy: 'slack',
    ...overrides,
  } as ProviderConfig;
}
