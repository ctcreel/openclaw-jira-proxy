import { describe, expect, it } from 'vitest';

import {
  getSessionKeyStrategy,
  listSessionKeyStrategies,
  registerSessionKeyStrategyForTest,
  type SessionKeyStrategy,
} from '../../../src/strategies/session-key';

describe('session-key strategy registry', () => {
  it('lists registered strategies', () => {
    const names = listSessionKeyStrategies();
    expect(names).toContain('slack');
  });

  it('resolves a registered strategy by name', () => {
    const strategy = getSessionKeyStrategy('slack');
    expect(strategy).toBeDefined();
    expect(strategy?.name).toBe('slack');
  });

  it('returns undefined for unknown names', () => {
    expect(getSessionKeyStrategy('nonexistent')).toBeUndefined();
  });

  it('test-only registration adds a strategy and the teardown restores prior state', () => {
    const fake: SessionKeyStrategy = {
      name: 'fake-test-only',
      extract: () => 'fake-key',
    };

    expect(getSessionKeyStrategy('fake-test-only')).toBeUndefined();
    const teardown = registerSessionKeyStrategyForTest(fake);
    expect(getSessionKeyStrategy('fake-test-only')).toBe(fake);
    teardown();
    expect(getSessionKeyStrategy('fake-test-only')).toBeUndefined();
  });

  it('test-only registration overrides an existing strategy and teardown restores it', () => {
    const original = getSessionKeyStrategy('slack');
    const replacement: SessionKeyStrategy = {
      name: 'slack',
      extract: () => 'override-key',
    };
    const teardown = registerSessionKeyStrategyForTest(replacement);
    expect(getSessionKeyStrategy('slack')).toBe(replacement);
    teardown();
    expect(getSessionKeyStrategy('slack')).toBe(original);
  });
});
