import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerRoutingStrategy,
  getRoutingStrategy,
  resetRoutingStrategies,
} from '../../../src/strategies/routing/registry';
import type { RoutingStrategy } from '../../../src/strategies/routing/types';

const fakeStrategy: RoutingStrategy = {
  name: 'fake',
  evaluate: () => 'fake-agent',
};

describe('routing registry', () => {
  beforeEach(() => {
    resetRoutingStrategies();
  });

  it('should register and retrieve a strategy', () => {
    registerRoutingStrategy(fakeStrategy);
    expect(getRoutingStrategy('fake')).toBe(fakeStrategy);
  });

  it('should throw for unknown strategy', () => {
    expect(() => getRoutingStrategy('nonexistent')).toThrow('Unknown routing strategy: nonexistent');
  });

  it('should overwrite a strategy with the same name', () => {
    const replacement: RoutingStrategy = { name: 'fake', evaluate: () => 'replaced' };
    registerRoutingStrategy(fakeStrategy);
    registerRoutingStrategy(replacement);
    expect(getRoutingStrategy('fake')).toBe(replacement);
  });

  it('should clear all strategies on reset', () => {
    registerRoutingStrategy(fakeStrategy);
    resetRoutingStrategies();
    expect(() => getRoutingStrategy('fake')).toThrow();
  });
});
