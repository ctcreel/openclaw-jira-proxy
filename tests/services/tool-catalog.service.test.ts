import { afterEach, describe, expect, it } from 'vitest';

import type { ToolDescriptor } from '../../src/services/tools/descriptor';
import { getToolCatalog, resetToolCatalog } from '../../src/services/tool-catalog.service';

afterEach(() => {
  resetToolCatalog();
});

function makeDescriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    directory: '/agents/winston/agency-tools/agency_tools/google/gmail_send',
    reference: 'agency_tools.google.gmail_send',
    name: 'gmail_send',
    description: 'Send an HTML Gmail message.',
    args: {
      to: { type: 'string', description: 'Recipient.' },
      body: { type: 'string', description: 'HTML body.' },
    },
    secrets: [],
    ...overrides,
  };
}

describe('ToolCatalog', () => {
  it('register exposes the entry in both the global list and the per-agent list', () => {
    const catalog = getToolCatalog();
    catalog.register('winston', makeDescriptor());

    const global = catalog.list();
    expect(global).toHaveLength(1);
    expect(global[0]?.name).toBe('gmail_send');
    expect(global[0]?.reference).toBe('agency_tools.google.gmail_send');

    const forAgent = catalog.listForAgent('winston');
    expect(forAgent).toHaveLength(1);
    expect(forAgent?.[0]?.name).toBe('gmail_send');
  });

  it('strips the on-disk directory from the public-facing entry', () => {
    const catalog = getToolCatalog();
    catalog.register('winston', makeDescriptor());
    const entry = catalog.list()[0];
    // The public entry is the operator-safe slice — no filesystem paths.
    expect(Object.keys(entry ?? {})).not.toContain('directory');
  });

  it('reduces secrets to canonical + aliases — no resolved values shape', () => {
    const catalog = getToolCatalog();
    catalog.register(
      'winston',
      makeDescriptor({
        secrets: [{ canonical: 'agent_token', aliases: ['PATCH_JIRA_TOKEN', 'JIRA_TOKEN'] }],
      }),
    );
    const entry = catalog.list()[0];
    expect(entry?.secrets).toEqual([
      { canonical: 'agent_token', aliases: ['PATCH_JIRA_TOKEN', 'JIRA_TOKEN'] },
    ]);
  });

  it('dedupes by reference when the same tool registers under multiple agents', () => {
    const catalog = getToolCatalog();
    const descriptor = makeDescriptor();
    catalog.register('winston', descriptor);
    catalog.register('patch', descriptor);

    expect(catalog.list()).toHaveLength(1);
    expect(catalog.listForAgent('winston')).toHaveLength(1);
    expect(catalog.listForAgent('patch')).toHaveLength(1);
  });

  it('listForAgent returns undefined when the agent never registered', () => {
    const catalog = getToolCatalog();
    expect(catalog.listForAgent('phantom')).toBeUndefined();
  });

  it('reset clears all state', () => {
    const catalog = getToolCatalog();
    catalog.register('winston', makeDescriptor());
    expect(catalog.list()).toHaveLength(1);

    catalog.reset();
    expect(catalog.list()).toHaveLength(0);
    expect(catalog.listForAgent('winston')).toBeUndefined();
  });
});
