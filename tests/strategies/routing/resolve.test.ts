import { describe, it, expect } from 'vitest';

import { resolveAgentFromAgents } from '../../../src/strategies/routing';
import type { ResolvedAgent } from '../../../src/services/agent-loader.service';
import type { Condition } from '../../../src/strategies/routing';

function agent(
  name: string,
  providerName: string,
  rules: Array<{ condition: Condition; messageTemplate?: string; name?: string }>,
  dir = `/agents/${name}`,
): ResolvedAgent {
  return {
    name,
    dir,
    config: {
      routing: { [providerName]: { rules } },
      modelRules: {},
    },
  };
}

describe('resolveAgentFromAgents', () => {
  it('returns null when no agents are configured', () => {
    expect(resolveAgentFromAgents({}, 'jira', [])).toBeNull();
  });

  it('returns null when no agent has rules for the provider', () => {
    const agents = [agent('patch', 'slack', [{ condition: { all_of: [] } }])];
    expect(resolveAgentFromAgents({}, 'jira', agents)).toBeNull();
  });

  it('returns null when no rule matches across any agent', () => {
    const agents = [
      agent('patch', 'jira', [{ condition: { equals: { field: 'assignee', value: 'Patches' } } }]),
      agent('scarlett', 'jira', [
        { condition: { equals: { field: 'assignee', value: 'Scarlett' } } },
      ]),
    ];
    expect(resolveAgentFromAgents({ assignee: 'Nobody' }, 'jira', agents)).toBeNull();
  });

  it('routes to the first matching rule inside the first agent', () => {
    const agents = [
      agent('patch', 'jira', [
        {
          condition: { equals: { field: 'assignee', value: 'Patches' } },
          messageTemplate: 'templates/jira.md',
        },
      ]),
    ];

    const resolved = resolveAgentFromAgents({ assignee: 'Patches' }, 'jira', agents);
    expect(resolved).toEqual({
      agentId: 'patch',
      agentDir: '/agents/patch',
      messageTemplate: 'templates/jira.md',
    });
  });

  it('walks agents in order — first agent with a matching rule wins', () => {
    const agents = [
      agent('patch', 'jira', [{ condition: { equals: { field: 'assignee', value: 'Patches' } } }]),
      agent('scarlett', 'jira', [{ condition: { all_of: [] } }]),
    ];

    expect(resolveAgentFromAgents({ assignee: 'Someone Else' }, 'jira', agents)).toEqual({
      agentId: 'scarlett',
      agentDir: '/agents/scarlett',
      messageTemplate: undefined,
    });
  });

  it('evaluates rules within an agent in order — first rule wins', () => {
    const agents = [
      agent('patch', 'jira', [
        {
          condition: { equals: { field: 'issuetype', value: 'Bug' } },
          messageTemplate: 'bug.md',
        },
        {
          condition: { all_of: [] },
          messageTemplate: 'catch-all.md',
        },
      ]),
    ];

    const resolved = resolveAgentFromAgents({ issuetype: 'Bug' }, 'jira', agents);
    expect(resolved?.messageTemplate).toBe('bug.md');
  });

  it('supports composite conditions (all_of + in)', () => {
    const agents = [
      agent('patch', 'jira', [
        {
          condition: {
            all_of: [
              { equals: { field: 'issuetype', value: 'Bug' } },
              { in: { field: 'status', values: ['Plan', 'Planning'] } },
            ],
          },
        },
      ]),
    ];

    expect(
      resolveAgentFromAgents({ issuetype: 'Bug', status: 'Planning' }, 'jira', agents),
    ).toEqual({
      agentId: 'patch',
      agentDir: '/agents/patch',
      messageTemplate: undefined,
    });

    expect(resolveAgentFromAgents({ issuetype: 'Bug', status: 'Done' }, 'jira', agents)).toBeNull();
  });

  it('surfaces the matched agent directory in the result', () => {
    const agents = [
      agent(
        'patch',
        'jira',
        [{ condition: { all_of: [] } }],
        '/opt/clawndom/agents/the-agency/workspaces/patch',
      ),
    ];

    const resolved = resolveAgentFromAgents({}, 'jira', agents);
    expect(resolved?.agentDir).toBe('/opt/clawndom/agents/the-agency/workspaces/patch');
  });
});
