import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerRoutingStrategy,
  resetRoutingStrategies,
  fieldEqualsStrategy,
  regexStrategy,
  defaultStrategy,
  resolveAgent,
} from '../../../src/strategies/routing';
import type { RoutingConfig } from '../../../src/strategies/routing';

describe('resolveAgent', () => {
  beforeEach(() => {
    resetRoutingStrategies();
    registerRoutingStrategy(fieldEqualsStrategy);
    registerRoutingStrategy(regexStrategy);
    registerRoutingStrategy(defaultStrategy);
  });

  it('should return global default when routing is undefined', () => {
    expect(resolveAgent({}, undefined, 'patch')).toBe('patch');
  });

  it('should return routing default when rules are empty', () => {
    const routing: RoutingConfig = { rules: [], default: 'main' };
    expect(resolveAgent({}, routing, 'patch')).toBe('main');
  });

  it('should return first matching rule agentId', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          strategy: 'field-equals',
          field: 'assignee',
          value: 'Patches',
          agentId: 'patch',
        },
        {
          strategy: 'regex',
          field: 'event',
          pattern: '.*',
          agentId: 'main',
        },
      ],
      default: 'fallback',
    };

    const payload = { assignee: 'Patches', event: 'updated' };
    expect(resolveAgent(payload, routing, 'global')).toBe('patch');
  });

  it('should skip non-matching rules and use second match', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          strategy: 'field-equals',
          field: 'assignee',
          value: 'Nobody',
          agentId: 'ghost',
        },
        {
          strategy: 'regex',
          field: 'event',
          pattern: '^updated$',
          agentId: 'main',
        },
      ],
    };

    const payload = { assignee: 'Patches', event: 'updated' };
    expect(resolveAgent(payload, routing, 'global')).toBe('main');
  });

  it('should fall through to routing default when no rules match', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          strategy: 'field-equals',
          field: 'assignee',
          value: 'Nobody',
          agentId: 'ghost',
        },
      ],
      default: 'fallback',
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toBe('fallback');
  });

  it('should fall through to global default when no rules match and no routing default', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          strategy: 'field-equals',
          field: 'assignee',
          value: 'Nobody',
          agentId: 'ghost',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toBe('global');
  });

  it('should return null when nothing matches and no defaults exist', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          strategy: 'field-equals',
          field: 'assignee',
          value: 'Nobody',
          agentId: 'ghost',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, '')).toBeNull();
  });

  it('should support the default strategy as a catch-all rule', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          strategy: 'field-equals',
          field: 'assignee',
          value: 'Nobody',
          agentId: 'ghost',
        },
        {
          strategy: 'default',
          agentId: 'catch-all',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toBe('catch-all');
  });
});
