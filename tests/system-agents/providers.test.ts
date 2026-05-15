import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetSettings } from '../../src/config';
import {
  buildBuilderCallbackProvider,
  buildBuilderDispatchProvider,
  buildSystemAgentProviders,
} from '../../src/system-agents/providers';

describe('system-agent providers', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env['CLAWNDOM_AGENT_TOKEN'];
    else process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
    resetSettings();
  });

  it('builds Builder dispatch provider at /webhooks/system/builder', () => {
    const provider = buildBuilderDispatchProvider('test-agent-token');
    expect(provider.name).toBe('builder-dispatch');
    expect(provider.transport).toBe('webhook');
    expect(provider.routePath).toBe('/webhooks/system/builder');
    expect(provider.signatureStrategy).toBe('bearer');
    expect(provider.hmacSecret).toBe('test-agent-token');
  });

  it('builds Builder callback provider at /webhooks/builder-callback', () => {
    const provider = buildBuilderCallbackProvider('test-agent-token');
    expect(provider.name).toBe('builder-callback');
    expect(provider.routePath).toBe('/webhooks/builder-callback');
    expect(provider.signatureStrategy).toBe('bearer');
    expect(provider.hmacSecret).toBe('test-agent-token');
  });

  it('buildSystemAgentProviders returns dispatch and callback when token is set', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    resetSettings();
    const providers = buildSystemAgentProviders();
    expect(providers).toHaveLength(2);
    expect(providers.map((provider) => provider.name)).toEqual([
      'builder-dispatch',
      'builder-callback',
    ]);
    for (const provider of providers) {
      expect(provider.hmacSecret).toBe('live-token');
    }
  });

  it('every provider in the bundle uses the bearer strategy', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    resetSettings();
    for (const provider of buildSystemAgentProviders()) {
      expect(provider.signatureStrategy).toBe('bearer');
    }
  });

  it('returns empty (fail-soft) when CLAWNDOM_AGENT_TOKEN is not set', () => {
    delete process.env['CLAWNDOM_AGENT_TOKEN'];
    resetSettings();
    expect(buildSystemAgentProviders()).toEqual([]);
  });
});
