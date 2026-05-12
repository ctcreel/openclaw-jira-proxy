import { describe, it, expect } from 'vitest';

import { extractWebhookContext } from '../../src/strategies/context';
import { makeProvider } from '../helpers/make-provider';

const jiraProvider = makeProvider({ name: 'jira', contextStrategy: 'jira' });
const githubProvider = makeProvider({ name: 'github', contextStrategy: 'github' });
const slackProvider = makeProvider({ name: 'slack', contextStrategy: 'slack' });

describe('jiraStrategy.extract', () => {
  it('extracts issue key, summary, and status from a transition payload', () => {
    const payload = {
      issue: {
        key: 'SPE-1622',
        fields: { summary: 'Wire SPE-2078 spec into Patches', status: { name: 'In Development' } },
      },
    };
    const ctx = extractWebhookContext(jiraProvider, payload);
    expect(ctx.id).toBe('SPE-1622');
    expect(ctx.title).toBe('Wire SPE-2078 spec into Patches');
    expect(ctx.status).toBe('In Development');
    expect(ctx.source).toBe('jira');
  });

  it('truncates a very long summary to 80 characters', () => {
    const longSummary = 'X'.repeat(200);
    const ctx = extractWebhookContext(jiraProvider, {
      issue: { key: 'SPE-1', fields: { summary: longSummary, status: { name: 'Open' } } },
    });
    expect(ctx.title).toHaveLength(80);
  });

  it('falls back to ? for every missing Jira field', () => {
    const ctx = extractWebhookContext(jiraProvider, {});
    expect(ctx.id).toBe('?');
    expect(ctx.title).toBe('?');
    expect(ctx.status).toBe('?');
    expect(ctx.source).toBe('jira');
  });
});

describe('githubStrategy.extract', () => {
  it('builds repo#PR for a pull_request payload', () => {
    const ctx = extractWebhookContext(githubProvider, {
      action: 'opened',
      repository: { full_name: 'SC0RED/clawndom' },
      pull_request: { number: 42, title: 'Migrate slack-chat to tool_use' },
    });
    expect(ctx.id).toBe('SC0RED/clawndom#42');
    expect(ctx.title).toBe('Migrate slack-chat to tool_use');
    expect(ctx.status).toBe('opened');
    expect(ctx.source).toBe('github');
  });

  it('builds repo#issue when only issue.number is present', () => {
    const ctx = extractWebhookContext(githubProvider, {
      action: 'labeled',
      repository: { full_name: 'SC0RED/clawndom' },
      issue: { number: 7, title: 'Audit flag for triage' },
    });
    expect(ctx.id).toBe('SC0RED/clawndom#7');
    expect(ctx.title).toBe('Audit flag for triage');
    expect(ctx.status).toBe('labeled');
  });

  it('handles a string issue.number (GitHub sometimes serializes as string)', () => {
    const ctx = extractWebhookContext(githubProvider, {
      repository: { full_name: 'SC0RED/clawndom' },
      issue: { number: '8', title: 'Stringified' },
    });
    expect(ctx.id).toBe('SC0RED/clawndom#8');
  });

  it('builds "repo <ref>" with title "push" for a push payload', () => {
    const ctx = extractWebhookContext(githubProvider, {
      action: 'push',
      repository: { full_name: 'SC0RED/clawndom' },
      ref: 'refs/heads/main',
    });
    expect(ctx.id).toBe('SC0RED/clawndom refs/heads/main');
    expect(ctx.title).toBe('push');
    expect(ctx.status).toBe('push');
  });

  it('truncates PR title to 80 characters', () => {
    const longTitle = 'X'.repeat(200);
    const ctx = extractWebhookContext(githubProvider, {
      repository: { full_name: 'SC0RED/clawndom' },
      pull_request: { number: 1, title: longTitle },
    });
    expect(ctx.title).toHaveLength(80);
  });

  it('falls back to ? for the title when the PR object lacks a title', () => {
    const ctx = extractWebhookContext(githubProvider, {
      repository: { full_name: 'SC0RED/clawndom' },
      pull_request: { number: 99 },
    });
    expect(ctx.title).toBe('?');
  });

  it('falls back to ? for repo when repository.full_name is missing', () => {
    const ctx = extractWebhookContext(githubProvider, {
      pull_request: { number: 1, title: 'No repo' },
    });
    expect(ctx.id).toBe('?#1');
  });

  it('returns ?/? when neither PR, issue, nor ref is present', () => {
    const ctx = extractWebhookContext(githubProvider, {
      repository: { full_name: 'SC0RED/clawndom' },
    });
    expect(ctx.id).toBe('SC0RED/clawndom');
    expect(ctx.title).toBe('?');
  });
});

describe('slackStrategy.extract', () => {
  it('extracts message text from rich-text blocks', () => {
    const ctx = extractWebhookContext(slackProvider, {
      event: {
        ts: '1712345678.000100',
        channel: 'C08V6MV0VNV',
        blocks: [{ text: { text: 'Hello Winston' } }],
      },
    });
    expect(ctx.id).toBe('1712345678.000100');
    expect(ctx.title).toBe('Hello Winston');
    expect(ctx.status).toBe('development');
    expect(ctx.source).toBe('slack');
  });

  it('extracts message text from a simple-text block (text-as-string fallback)', () => {
    const ctx = extractWebhookContext(slackProvider, {
      event: {
        ts: '1.0',
        channel: 'C08V6MV0VNV',
        blocks: [{ text: 'plain string text' }],
      },
    });
    expect(ctx.title).toBe('plain string text');
  });

  it('truncates a long block text to 80 characters', () => {
    const ctx = extractWebhookContext(slackProvider, {
      event: {
        ts: '1.0',
        channel: 'C08V6MV0VNV',
        blocks: [{ text: { text: 'Y'.repeat(200) } }],
      },
    });
    expect(ctx.title).toHaveLength(80);
  });

  it.each([
    {
      label: 'maps testing channel ID to status: testing',
      channel: 'C08UWMQJFBN',
      expected: 'testing',
    },
    {
      label: 'maps production channel ID to status: production',
      channel: 'C08UVJDJZTL',
      expected: 'production',
    },
    {
      label: 'maps an unknown channel ID to status: unknown',
      channel: 'C_UNKNOWN',
      expected: 'unknown',
    },
    {
      label: 'handles missing channel gracefully (empty-string lookup → unknown)',
      channel: undefined,
      expected: 'unknown',
    },
  ])('$label', ({ channel, expected }) => {
    const event: Record<string, unknown> = { ts: '1.0', blocks: [] };
    if (channel !== undefined) event['channel'] = channel;
    const ctx = extractWebhookContext(slackProvider, { event });
    expect(ctx.status).toBe(expected);
  });

  it('returns title ? when blocks list is empty', () => {
    const ctx = extractWebhookContext(slackProvider, {
      event: { ts: '1.0', channel: 'C08V6MV0VNV', blocks: [] },
    });
    expect(ctx.title).toBe('?');
  });

  it('returns title ? when blocks is not an array', () => {
    const ctx = extractWebhookContext(slackProvider, {
      event: { ts: '1.0', channel: 'C08V6MV0VNV', blocks: 'not-an-array' },
    });
    expect(ctx.title).toBe('?');
  });

  it('returns id ? when event.ts is missing', () => {
    const ctx = extractWebhookContext(slackProvider, {
      event: { channel: 'C08V6MV0VNV', blocks: [] },
    });
    expect(ctx.id).toBe('?');
  });
});
