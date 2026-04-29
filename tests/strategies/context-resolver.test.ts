import { describe, it, expect } from 'vitest';

import { providerSchema } from '../../src/config';
import { extractWebhookContext, getContextStrategy } from '../../src/strategies/context';
import { makeProvider } from '../helpers/make-provider';

const slackPayload = {
  event: { ts: '1712345678.123456', channel: 'C08V6MV0VNV', blocks: [] },
};

describe('getContextStrategy resolver', () => {
  it('routes a non-default-named provider to its declared contextStrategy', () => {
    // slack-winston has a non-matching name; the override forces the slack extractor.
    const provider = makeProvider({ name: 'slack-winston', contextStrategy: 'slack' });

    expect(getContextStrategy(provider).name).toBe('slack');

    const context = extractWebhookContext(provider, slackPayload);
    expect(context.id).toBe('1712345678.123456');
    expect(context.source).toBe('slack');
  });

  it('falls through to the unknown strategy when a non-default name has no override', () => {
    // Regression guard: this is the exact bug SPE-1959 fixes. Any future
    // "helpful" change that silently routes by name (or aliases slack-* to slack)
    // would make this test fail — which is the point.
    const provider = makeProvider({ name: 'slack-winston' });

    expect(getContextStrategy(provider).name).toBe('unknown');

    const context = extractWebhookContext(provider, slackPayload);
    expect(context.id).toBe('?');
    expect(context.title).toBe('?');
    expect(context.status).toBe('?');
    expect(context.source).toBe('unknown');
  });

  it('preserves back-compat: name-only resolution still works for default-named providers', () => {
    const provider = makeProvider({ name: 'slack' });

    expect(getContextStrategy(provider).name).toBe('slack');

    const context = extractWebhookContext(provider, slackPayload);
    expect(context.id).toBe('1712345678.123456');
    expect(context.source).toBe('slack');
  });
});

describe('providerSchema contextStrategy field', () => {
  it('rejects providers with a typoed contextStrategy', () => {
    const result = providerSchema.safeParse({
      name: 'slack-winston',
      transport: 'webhook',
      routePath: '/slack',
      signatureStrategy: 'slack',
      contextStrategy: 'bogus',
    });
    expect(result.success).toBe(false);
  });
});
