import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetSettings } from '../../src/config';
import {
  buildBuilderCallbackProvider,
  buildBuilderDispatchProvider,
  buildSystemAgentProviders,
} from '../../src/system-agents/providers';

const CLAUDE_CLI_PROVIDER = {
  name: 'workspace-claude-cli',
  routePath: '/hooks/workspace',
  hmacSecret: 'workspace-hmac',
  signatureStrategy: 'websub' as const,
  runner: {
    type: 'claude-cli' as const,
    workDirectory: '/home/clawndom/.clawndom/agents/workspace',
    binary: '/usr/bin/claude',
  },
};

const STANDIN_RUNNER = {
  type: 'claude-cli' as const,
  workDirectory: '/scratch/builder',
  workDirectoryStrategy: 'per-dispatch' as const,
  binary: '/usr/bin/claude',
};

describe('system-agent providers', () => {
  let originalToken: string | undefined;
  let originalProviders: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
    originalProviders = process.env['PROVIDERS_CONFIG'];
    originalConfigDir = process.env['CLAWNDOM_CONFIG_DIR'];
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env['CLAWNDOM_AGENT_TOKEN'];
    else process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
    if (originalProviders === undefined) delete process.env['PROVIDERS_CONFIG'];
    else process.env['PROVIDERS_CONFIG'] = originalProviders;
    if (originalConfigDir === undefined) delete process.env['CLAWNDOM_CONFIG_DIR'];
    else process.env['CLAWNDOM_CONFIG_DIR'] = originalConfigDir;
    resetSettings();
  });

  it('builds Builder dispatch provider at /webhooks/system/builder', () => {
    const provider = buildBuilderDispatchProvider('test-agent-token', STANDIN_RUNNER);
    expect(provider.name).toBe('builder-dispatch');
    expect(provider.transport).toBe('webhook');
    expect(provider.routePath).toBe('/webhooks/system/builder');
    expect(provider.signatureStrategy).toBe('bearer');
    expect(provider.hmacSecret).toBe('test-agent-token');
    expect(provider.runner).toEqual(STANDIN_RUNNER);
  });

  it('builds Builder callback provider at /webhooks/builder-callback', () => {
    const provider = buildBuilderCallbackProvider('test-agent-token', STANDIN_RUNNER);
    expect(provider.name).toBe('builder-callback');
    expect(provider.routePath).toBe('/webhooks/builder-callback');
    expect(provider.signatureStrategy).toBe('bearer');
    expect(provider.hmacSecret).toBe('test-agent-token');
    expect(provider.runner).toEqual(STANDIN_RUNNER);
  });

  it('buildSystemAgentProviders returns dispatch and callback when token + claude-cli provider are set', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    process.env['CLAWNDOM_CONFIG_DIR'] = '/home/clawndom/.clawndom/agents';
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([CLAUDE_CLI_PROVIDER]);
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
    process.env['CLAWNDOM_CONFIG_DIR'] = '/home/clawndom/.clawndom/agents';
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([CLAUDE_CLI_PROVIDER]);
    resetSettings();
    for (const provider of buildSystemAgentProviders()) {
      expect(provider.signatureStrategy).toBe('bearer');
    }
  });

  it('inherits binary from the first claude-cli provider', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    process.env['CLAWNDOM_CONFIG_DIR'] = '/home/clawndom/.clawndom/agents';
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([CLAUDE_CLI_PROVIDER]);
    resetSettings();
    for (const provider of buildSystemAgentProviders()) {
      expect(provider.runner?.type).toBe('claude-cli');
      if (provider.runner?.type === 'claude-cli') {
        expect(provider.runner.binary).toBe('/usr/bin/claude');
      }
    }
  });

  it('stamps workDirectoryStrategy: per-dispatch on every system-agent provider', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    process.env['CLAWNDOM_CONFIG_DIR'] = '/home/clawndom/.clawndom/agents';
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([CLAUDE_CLI_PROVIDER]);
    resetSettings();
    for (const provider of buildSystemAgentProviders()) {
      if (provider.runner?.type === 'claude-cli') {
        expect(provider.runner.workDirectoryStrategy).toBe('per-dispatch');
      } else {
        throw new Error('expected claude-cli runner');
      }
    }
  });

  it('scratch root is the system-agents sibling of configDir', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    process.env['CLAWNDOM_CONFIG_DIR'] = '/home/clawndom/.clawndom/agents';
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([CLAUDE_CLI_PROVIDER]);
    resetSettings();
    const expected = join('/home/clawndom/.clawndom', 'system-agents', 'builder');
    for (const provider of buildSystemAgentProviders()) {
      if (provider.runner?.type === 'claude-cli') {
        expect(provider.runner.workDirectory).toBe(expected);
      }
    }
  });

  it('returns empty (fail-soft) when CLAWNDOM_AGENT_TOKEN is not set', () => {
    delete process.env['CLAWNDOM_AGENT_TOKEN'];
    resetSettings();
    expect(buildSystemAgentProviders()).toEqual([]);
  });

  it('returns empty (fail-soft) when no claude-cli provider is configured', () => {
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'live-token';
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([
      {
        name: 'openclaw-only',
        routePath: '/hooks/openclaw',
        hmacSecret: 'h',
        signatureStrategy: 'websub',
        openclawHookUrl: 'http://127.0.0.1:18789/hooks/openclaw',
      },
    ]);
    resetSettings();
    expect(buildSystemAgentProviders()).toEqual([]);
  });
});
