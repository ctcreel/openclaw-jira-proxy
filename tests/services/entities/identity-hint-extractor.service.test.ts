import { describe, expect, it } from 'vitest';

import { extractIdentityHints } from '../../../src/services/entities/identity-hint-extractor.service';

describe('extractIdentityHints', () => {
  it('slack: lifts event.user as slack_user_id', () => {
    const hints = extractIdentityHints('slack', {
      event: { user: 'U_HEATHER', type: 'message', text: 'hi' },
    });
    expect(hints).toEqual({ slack_user_id: 'U_HEATHER' });
  });

  it('slack: falls back to top-level user when event.user missing', () => {
    const hints = extractIdentityHints('slack', { user: 'U_HEATHER' });
    expect(hints.slack_user_id).toBe('U_HEATHER');
  });

  it('gmail: extracts plain email from from-field', () => {
    const hints = extractIdentityHints('gmail', {
      from: 'heather@talkatlanta.info',
    });
    expect(hints).toEqual({ email: 'heather@talkatlanta.info' });
  });

  it('gmail: extracts email from "Name <email>" format', () => {
    const hints = extractIdentityHints('gmail', {
      from: 'Heather Hamilton <heather@talkatlanta.info>',
    });
    expect(hints.email).toBe('heather@talkatlanta.info');
  });

  it('gmail: returns empty when no recognizable email', () => {
    const hints = extractIdentityHints('gmail', { from: 'just-a-name' });
    expect(hints).toEqual({});
  });

  it('http: lifts dispatching_actor_email + oidc_email', () => {
    const hints = extractIdentityHints('http', {
      dispatching_actor_email: 'chris@talkatlanta.info',
      oidc_email: 'chris@example.com',
    });
    expect(hints).toEqual({
      email: 'chris@talkatlanta.info',
      oidc_email: 'chris@example.com',
    });
  });

  it('unknown surface returns empty', () => {
    const hints = extractIdentityHints('unknown', { from: 'h@x.com' });
    expect(hints).toEqual({});
  });

  it('non-object payload returns empty', () => {
    expect(extractIdentityHints('slack', null)).toEqual({});
    expect(extractIdentityHints('gmail', 'not-an-object')).toEqual({});
  });
});
