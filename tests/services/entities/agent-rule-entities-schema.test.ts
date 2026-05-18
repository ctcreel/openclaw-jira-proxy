import { describe, expect, it } from 'vitest';

import { agentRuleSchema } from '../../../src/services/agent-loader.service';

describe('agentRuleSchema: entities + interactions blocks', () => {
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

  it('accepts a rule with interactions config', () => {
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      entities: { kinds: ['team_member', 'interaction'] },
      interactions: { topN: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interactions?.topN).toBe(5);
      expect(result.data.interactions?.includeMentionsOfRelatedEntities).toBe(false);
    }
  });

  it('rejects empty entities.kinds list', () => {
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      entities: { kinds: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects interactions.topN exceeding cap', () => {
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      interactions: { topN: 100 },
    });
    expect(result.success).toBe(false);
  });

  it('parses includeMentionsOfRelatedEntities when supplied', () => {
    const result = agentRuleSchema.safeParse({
      name: 'chat',
      entities: { kinds: ['contact'] },
      interactions: { topN: 3, includeMentionsOfRelatedEntities: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interactions?.includeMentionsOfRelatedEntities).toBe(true);
    }
  });

  it('rule without entities or interactions still parses (backward compat)', () => {
    const result = agentRuleSchema.safeParse({
      name: 'refresh-gmail-watch',
      cron: '0 */6 * * *',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities).toBeUndefined();
      expect(result.data.interactions).toBeUndefined();
    }
  });
});
