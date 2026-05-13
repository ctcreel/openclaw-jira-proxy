import { describe, expect, it } from 'vitest';

import { getProviderPayloadSchema } from '../../../src/strategies/payload-schemas';

describe('getProviderPayloadSchema', () => {
  it.each(['internal', 'schedule', 'jira', 'github', 'slack', 'gmail-pubsub'])(
    'returns a schema for the canonical provider name %s',
    (name) => {
      expect(getProviderPayloadSchema(name)).toBeDefined();
    },
  );

  it('resolves operator-named slack providers (slack-winston) to the slack schema', () => {
    const schema = getProviderPayloadSchema('slack-winston');
    expect(schema?.properties?.['event']).toBeDefined();
  });

  it('resolves operator-named gmail providers (gmail-heather) to the gmail-pubsub schema', () => {
    const schema = getProviderPayloadSchema('gmail-heather');
    expect(schema?.properties?.['emailAddress']).toBeDefined();
  });

  it('returns undefined for unknown providers', () => {
    expect(getProviderPayloadSchema('zapier')).toBeUndefined();
  });
});
