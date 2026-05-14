import { describe, it, expect } from 'vitest';

import { redactCredentials } from '../../../src/lib/audit/redact';

describe('redactCredentials', () => {
  it('replaces an exact-match credential value with <redacted>', () => {
    const result = redactCredentials({ channel: 'C123', bot_token: 'xoxb-actual-secret-value' }, [
      'xoxb-actual-secret-value',
    ]);
    expect(result).toEqual({ channel: 'C123', bot_token: '<redacted>' });
  });

  it('preserves non-matching strings', () => {
    const result = redactCredentials({ text: 'hello world', user: 'U456' }, ['xoxb-secret']);
    expect(result).toEqual({ text: 'hello world', user: 'U456' });
  });

  it('redacts within nested objects', () => {
    const result = redactCredentials({ outer: { inner: 'xoxb-secret', other: 'safe' } }, [
      'xoxb-secret',
    ]);
    expect(result).toEqual({ outer: { inner: '<redacted>', other: 'safe' } });
  });

  it('redacts within arrays', () => {
    const result = redactCredentials(['xoxb-secret', 'safe', 'xoxb-secret'], ['xoxb-secret']);
    expect(result).toEqual(['<redacted>', 'safe', '<redacted>']);
  });

  it('redacts multiple distinct secrets', () => {
    const result = redactCredentials({ a: 'token1', b: 'token2', c: 'unrelated' }, [
      'token1',
      'token2',
    ]);
    expect(result).toEqual({ a: '<redacted>', b: '<redacted>', c: 'unrelated' });
  });

  it('returns input unchanged when no secrets configured', () => {
    const input = { foo: 'bar' };
    expect(redactCredentials(input, [])).toEqual(input);
  });

  it('preserves null and undefined values', () => {
    const result = redactCredentials({ a: null, b: undefined, c: 'safe' }, ['secret']);
    expect(result).toEqual({ a: null, b: undefined, c: 'safe' });
  });

  it('preserves numbers and booleans', () => {
    const result = redactCredentials({ n: 42, b: true, s: 'secret' }, ['secret']);
    expect(result).toEqual({ n: 42, b: true, s: '<redacted>' });
  });

  it('redacts substring occurrences inside larger strings', () => {
    // A credential embedded in a URL, error message, or env dump is the
    // exact pattern an adversarial impl would use to exfiltrate. The
    // redactor catches it.
    const result = redactCredentials({ url: 'https://example.com?token=xoxb-secret&other=foo' }, [
      'xoxb-secret',
    ]);
    expect(result).toEqual({ url: 'https://example.com?token=<redacted>&other=foo' });
  });

  it('redacts every occurrence when the secret appears multiple times in one string', () => {
    const result = redactCredentials({ dump: 'A=xoxb-secret B=xoxb-secret C=safe' }, [
      'xoxb-secret',
    ]);
    expect(result).toEqual({ dump: 'A=<redacted> B=<redacted> C=safe' });
  });

  it('redacts the longer secret first so a prefix overlap does not leak the tail', () => {
    // If 'foo' were redacted before 'foobar', the tail 'bar' would leak.
    const result = redactCredentials({ s: 'foobar' }, ['foo', 'foobar']);
    expect(result).toEqual({ s: '<redacted>' });
  });
});
