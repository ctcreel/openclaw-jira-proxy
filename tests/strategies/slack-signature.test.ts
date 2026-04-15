import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { getSignatureStrategy } from '../../src/strategies/signature';

function computeSlackSignature(secret: string, timestamp: string, body: string): string {
  const basestring = `v0:${timestamp}:${body}`;
  const hex = createHmac('sha256', secret).update(basestring).digest('hex');
  return `v0=${hex}`;
}

describe('slack signature strategy', () => {
  const strategy = getSignatureStrategy('slack');
  const secret = 'slack-signing-secret';
  const body = '{"type":"event_callback","event":{"type":"message"}}';
  const rawBody = Buffer.from(body);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use x-slack-signature header', () => {
    expect(strategy.headerName).toBe('x-slack-signature');
  });

  it('should require x-slack-request-timestamp additional header', () => {
    expect(strategy.additionalHeaders).toEqual(['x-slack-request-timestamp']);
  });

  it('should validate a correct signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(secret, timestamp, body);

    expect(
      strategy.validate(rawBody, signature, secret, {
        'x-slack-request-timestamp': timestamp,
      }),
    ).toBe(true);
  });

  it('should reject an incorrect signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(
      strategy.validate(
        rawBody,
        'v0=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        secret,
        {
          'x-slack-request-timestamp': timestamp,
        },
      ),
    ).toBe(false);
  });

  it('should reject a signature with wrong prefix', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(
      strategy.validate(rawBody, 'sha256=abc123', secret, {
        'x-slack-request-timestamp': timestamp,
      }),
    ).toBe(false);
  });

  it('should reject when timestamp header is missing', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(secret, timestamp, body);

    expect(strategy.validate(rawBody, signature, secret, {})).toBe(false);
  });

  it('should reject when timestamp is not a number', () => {
    const signature = computeSlackSignature(secret, 'not-a-number', body);

    expect(
      strategy.validate(rawBody, signature, secret, {
        'x-slack-request-timestamp': 'not-a-number',
      }),
    ).toBe(false);
  });

  it('should reject replay attacks with old timestamps', () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = computeSlackSignature(secret, oldTimestamp, body);

    expect(
      strategy.validate(rawBody, signature, secret, {
        'x-slack-request-timestamp': oldTimestamp,
      }),
    ).toBe(false);
  });

  it('should accept timestamps within the 5-minute window', () => {
    const recentTimestamp = String(Math.floor(Date.now() / 1000) - 200);
    const signature = computeSlackSignature(secret, recentTimestamp, body);

    expect(
      strategy.validate(rawBody, signature, secret, {
        'x-slack-request-timestamp': recentTimestamp,
      }),
    ).toBe(true);
  });
});
