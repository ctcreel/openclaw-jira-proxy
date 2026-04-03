import { describe, it, expect } from 'vitest';
import { getSignatureStrategy } from '../../src/strategies/signature';

describe('getSignatureStrategy', () => {
  it('should return known strategies', () => {
    for (const name of ['websub', 'github', 'bearer']) {
      const strategy = getSignatureStrategy(name);
      expect(strategy).toBeDefined();
      expect(typeof strategy.validate).toBe('function');
    }
  });

  it('should throw for unknown strategy', () => {
    expect(() => getSignatureStrategy('bogus')).toThrow('Unknown signature strategy: bogus');
  });

  describe('bearer strategy', () => {
    const strategy = getSignatureStrategy('bearer');

    it('should validate matching bearer token', () => {
      const body = Buffer.from('{"message":{"data":"test"}}');
      const secret = 'my-shared-token-123';
      const header = `Bearer ${secret}`;
      expect(strategy.validate(body, header, secret)).toBe(true);
    });

    it('should reject mismatched bearer token', () => {
      const body = Buffer.from('{}');
      expect(strategy.validate(body, 'Bearer wrong-token', 'correct-token')).toBe(false);
    });

    it('should reject non-Bearer auth header', () => {
      const body = Buffer.from('{}');
      expect(strategy.validate(body, 'Basic abc123', 'abc123')).toBe(false);
    });

    it('should reject tokens of different length', () => {
      const body = Buffer.from('{}');
      expect(strategy.validate(body, 'Bearer short', 'much-longer-secret')).toBe(false);
    });

    it('should use authorization header', () => {
      expect(strategy.headerName).toBe('authorization');
    });
  });
});
