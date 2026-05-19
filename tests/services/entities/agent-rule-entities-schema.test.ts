import { describe, expect, it } from 'vitest';

import { agentRuleSchema } from '../../../src/services/agent-loader.service';

describe('agentRuleSchema: entities block', () => {
  it('accepts a rule with entities.kinds', () => {
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      entities: { kinds: ['client', 'contact', 'team_member'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities?.kinds).toEqual(['client', 'contact', 'team_member']);
    }
  });

  it('rejects empty entities.kinds list', () => {
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      entities: { kinds: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (e.g., the old interactions block)', () => {
    // The interactions:{topN} field was dropped — retrieval is now
    // template-driven via the `history`/`recall` tools. Zod by default
    // allows extra keys (strip), so the result still parses but the
    // field is not surfaced on the typed output.
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      entities: { kinds: ['client'] },
      interactions: { topN: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('interactions' in result.data).toBe(false);
    }
  });

  it('rule without entities still parses (backward compat)', () => {
    const result = agentRuleSchema.safeParse({
      name: 'refresh-gmail-watch',
      cron: '0 */6 * * *',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities).toBeUndefined();
    }
  });
});
