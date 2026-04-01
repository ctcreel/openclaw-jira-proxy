import { describe, it, expect } from 'vitest';
import { getSignatureStrategy } from '../../src/strategies/signature';

describe('getSignatureStrategy', () => {
  it('should return known strategies', () => {
    for (const name of ['websub', 'github']) {
      const strategy = getSignatureStrategy(name);
      expect(strategy).toBeDefined();
      expect(typeof strategy.validate).toBe('function');
    }
  });

  it('should throw for unknown strategy', () => {
    expect(() => getSignatureStrategy('bogus')).toThrow('Unknown signature strategy: bogus');
  });
});
