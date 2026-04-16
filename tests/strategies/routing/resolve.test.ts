import { describe, it, expect } from 'vitest';

import { resolveAgent } from '../../../src/strategies/routing';
import type { RoutingConfig } from '../../../src/strategies/routing';

describe('resolveAgent', () => {
  it('should return global default when routing is undefined', () => {
    expect(resolveAgent({}, undefined, 'patch')).toEqual({ agentId: 'patch' });
  });

  it('should return routing default when rules are empty', () => {
    const routing: RoutingConfig = { rules: [], default: 'main' };
    expect(resolveAgent({}, routing, 'patch')).toEqual({ agentId: 'main' });
  });

  it('should return first matching rule agentId', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Patches' } },
          agentId: 'patch',
        },
        {
          condition: { matches: { field: 'event', pattern: '.*' } },
          agentId: 'main',
        },
      ],
      default: 'fallback',
    };

    const payload = { assignee: 'Patches', event: 'updated' };
    expect(resolveAgent(payload, routing, 'global')).toEqual({
      agentId: 'patch',
      messageTemplate: undefined,
    });
  });

  it('should skip non-matching rules and use second match', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Nobody' } },
          agentId: 'ghost',
        },
        {
          condition: { matches: { field: 'event', pattern: '^updated$' } },
          agentId: 'main',
        },
      ],
    };

    const payload = { assignee: 'Patches', event: 'updated' };
    expect(resolveAgent(payload, routing, 'global')).toEqual({
      agentId: 'main',
      messageTemplate: undefined,
    });
  });

  it('should fall through to routing default when no rules match', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Nobody' } },
          agentId: 'ghost',
        },
      ],
      default: 'fallback',
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toEqual({
      agentId: 'fallback',
    });
  });

  it('should fall through to global default when no rules match and no routing default', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Nobody' } },
          agentId: 'ghost',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toEqual({ agentId: 'global' });
  });

  it('should return null when nothing matches and no defaults exist', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Nobody' } },
          agentId: 'ghost',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, '')).toBeNull();
  });

  it('should support an empty all_of condition as a catch-all rule', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Nobody' } },
          agentId: 'ghost',
        },
        {
          condition: { all_of: [] },
          agentId: 'catch-all',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toEqual({
      agentId: 'catch-all',
      messageTemplate: undefined,
    });
  });

  it('should route on composite all_of (AND) conditions', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: {
            all_of: [
              { equals: { field: 'issuetype', value: 'Bug' } },
              { in: { field: 'status', values: ['Plan', 'Planning'] } },
            ],
          },
          agentId: 'patch',
        },
      ],
      default: 'main',
    };

    expect(resolveAgent({ issuetype: 'Bug', status: 'Planning' }, routing, 'global')).toEqual({
      agentId: 'patch',
      messageTemplate: undefined,
    });

    expect(resolveAgent({ issuetype: 'Bug', status: 'Done' }, routing, 'global')).toEqual({
      agentId: 'main',
    });
  });

  it('should include messageTemplate from matched rule', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Patches' } },
          agentId: 'patch',
          messageTemplate: 'Issue {{ issue.key }} assigned',
        },
      ],
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toEqual({
      agentId: 'patch',
      messageTemplate: 'Issue {{ issue.key }} assigned',
    });
  });

  it('should skip global fallback when routing.default is explicitly null', () => {
    const routing: RoutingConfig = {
      rules: [
        {
          condition: { equals: { field: 'assignee', value: 'Nobody' } },
          agentId: 'ghost',
        },
      ],
      default: null,
    };

    expect(resolveAgent({ assignee: 'Patches' }, routing, 'global')).toBeNull();
  });
});
