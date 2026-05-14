import { describe, it, expect } from 'vitest';

import { loadSystemAgents } from '../../src/system-agents/loader';

describe('loadSystemAgents', () => {
  it('discovers Builder under src/system-agents/builder/clawndom.yaml', async () => {
    const agents = await loadSystemAgents();
    const builder = agents.find((agent) => agent.name === 'builder');
    expect(builder).toBeDefined();
    expect(builder?.dir.endsWith('src/system-agents/builder')).toBe(true);
  });

  it("parses Builder's clawndom.yaml under the standard agentConfigSchema", async () => {
    const agents = await loadSystemAgents();
    const builder = agents.find((agent) => agent.name === 'builder');
    expect(builder?.config.routing['builder-dispatch']).toBeDefined();
    const rules = builder?.config.routing['builder-dispatch']?.rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0]?.messageTemplate).toMatch(/templates\/dispatch\.njk$/);
  });

  it('does not surface non-directory or non-yaml entries', async () => {
    const agents = await loadSystemAgents();
    for (const agent of agents) {
      expect(agent.config).toBeDefined();
      expect(agent.name).not.toMatch(/\./);
    }
  });
});
