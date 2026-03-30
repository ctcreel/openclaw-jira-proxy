import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertRegistry, buildAlertRegistry } from '../../../src/services/alerts';
import type { AlertProvider, JobAlert } from '../../../src/services/alerts';

function makeAlert(overrides?: Partial<JobAlert>): JobAlert {
  return {
    jobId: 'job-1',
    sessionKey: 'hook:jira:job-1',
    agentId: 'patch',
    error: 'timeout',
    attempts: 2,
    maxAttempts: 2,
    provider: 'jira',
    failedAt: new Date('2026-03-30T20:00:00Z'),
    ...overrides,
  };
}

function mockProvider(name: string): AlertProvider & { send: ReturnType<typeof vi.fn> } {
  return { name, send: vi.fn().mockResolvedValue(undefined) };
}

describe('AlertRegistry', () => {
  it('should include log provider by default', () => {
    const registry = new AlertRegistry();
    expect(registry.names).toContain('log');
  });

  it('should add providers', () => {
    const registry = new AlertRegistry();
    const provider = mockProvider('test');
    registry.add(provider);
    expect(registry.names).toContain('test');
    expect(registry.count).toBe(2); // log + test
  });

  it('should fan out alerts to all providers', async () => {
    const p1 = mockProvider('p1');
    const p2 = mockProvider('p2');
    const registry = new AlertRegistry([p1, p2]);

    const alert = makeAlert();
    await registry.sendAll(alert);

    expect(p1.send).toHaveBeenCalledWith(alert);
    expect(p2.send).toHaveBeenCalledWith(alert);
  });

  it('should not throw when a provider fails', async () => {
    const good = mockProvider('good');
    const bad: AlertProvider = {
      name: 'bad',
      send: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const registry = new AlertRegistry([good, bad]);

    await expect(registry.sendAll(makeAlert())).resolves.toBeUndefined();
    expect(good.send).toHaveBeenCalled();
  });
});

describe('buildAlertRegistry', () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    'ALERT_SLACK_WEBHOOK_URL',
    'ALERT_SLACK_TOKEN',
    'ALERT_SLACK_CHANNEL',
    'ALERT_DISCORD_WEBHOOK_URL',
    'ALERT_HTTP_URL',
    'ALERT_HTTP_HEADERS',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });

  it('should only have log provider when no env vars set', () => {
    const registry = buildAlertRegistry();
    expect(registry.names).toEqual(['log']);
  });

  it('should add Slack provider when webhook URL is set', () => {
    process.env.ALERT_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    const registry = buildAlertRegistry();
    expect(registry.names).toContain('slack');
  });

  it('should add Slack provider when token + channel are set', () => {
    process.env.ALERT_SLACK_TOKEN = 'xoxb-test';
    process.env.ALERT_SLACK_CHANNEL = 'C000';
    const registry = buildAlertRegistry();
    expect(registry.names).toContain('slack');
  });

  it('should not add Slack when token set without channel', () => {
    process.env.ALERT_SLACK_TOKEN = 'xoxb-test';
    // no channel
    const registry = buildAlertRegistry();
    expect(registry.names).not.toContain('slack');
  });

  it('should add Discord provider when webhook URL is set', () => {
    process.env.ALERT_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    const registry = buildAlertRegistry();
    expect(registry.names).toContain('discord');
  });

  it('should add HTTP provider when URL is set', () => {
    process.env.ALERT_HTTP_URL = 'https://alerts.example.com/webhook';
    const registry = buildAlertRegistry();
    expect(registry.names).toContain('http');
  });

  it('should add multiple providers simultaneously', () => {
    process.env.ALERT_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.ALERT_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    process.env.ALERT_HTTP_URL = 'https://alerts.example.com/webhook';
    const registry = buildAlertRegistry();
    expect(registry.names).toEqual(expect.arrayContaining(['log', 'slack', 'discord', 'http']));
  });
});
