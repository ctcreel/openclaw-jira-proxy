import { describe, it, expect } from 'vitest';

import {
  builderAgentFieldsSchema,
  isOptedInToBuilder,
  testableMechanismSchema,
  validateBuilderAgentFields,
} from '../../../src/system-agents/builder/agent-config';
import { agentEntrySchema } from '../../../src/config';

describe('testableMechanismSchema', () => {
  it('accepts deploy_webhook with a webhookUrl', () => {
    const parsed = testableMechanismSchema.parse({
      type: 'deploy_webhook',
      webhookUrl: 'https://supervisor.example.com/deploy-complete',
    });
    expect(parsed.type).toBe('deploy_webhook');
  });

  it('accepts cache_refresh with no extras', () => {
    expect(testableMechanismSchema.parse({ type: 'cache_refresh' })).toEqual({
      type: 'cache_refresh',
    });
  });

  it('accepts pr_preview with a previewResolver', () => {
    const parsed = testableMechanismSchema.parse({
      type: 'pr_preview',
      previewResolver: 'vercel:winston-preview',
    });
    expect(parsed.type).toBe('pr_preview');
  });

  it('rejects deploy_webhook without webhookUrl', () => {
    expect(() => testableMechanismSchema.parse({ type: 'deploy_webhook' })).toThrow();
  });

  it('rejects deploy_webhook with a non-URL webhookUrl', () => {
    expect(() =>
      testableMechanismSchema.parse({ type: 'deploy_webhook', webhookUrl: 'not-a-url' }),
    ).toThrow();
  });

  it('rejects unknown mechanism types', () => {
    expect(() => testableMechanismSchema.parse({ type: 'magic' })).toThrow();
  });
});

describe('builderAgentFieldsSchema', () => {
  it('parses an empty object (agent not opted in)', () => {
    const parsed = builderAgentFieldsSchema.parse({});
    expect(parsed).toEqual({});
  });

  it('parses a fully-opted-in record', () => {
    const parsed = builderAgentFieldsSchema.parse({
      builderBotRef: 'builder_bot_the_agency',
      operatorAllowlist: ['heather@example.com'],
      testableMechanism: {
        type: 'deploy_webhook',
        webhookUrl: 'https://supervisor.example.com/deploy-complete',
      },
    });
    expect(parsed.builderBotRef).toBe('builder_bot_the_agency');
    expect(parsed.operatorAllowlist).toEqual(['heather@example.com']);
  });

  it('accepts an empty operatorAllowlist (means "refuse all")', () => {
    const parsed = builderAgentFieldsSchema.parse({
      builderBotRef: 'builder_bot_the_agency',
      operatorAllowlist: [],
      testableMechanism: { type: 'cache_refresh' },
    });
    expect(parsed.operatorAllowlist).toEqual([]);
  });

  it('rejects non-email values in operatorAllowlist', () => {
    expect(() =>
      builderAgentFieldsSchema.parse({
        operatorAllowlist: ['not-an-email'],
      }),
    ).toThrow();
  });

  it('accepts an optional branchNamingPattern override', () => {
    const parsed = builderAgentFieldsSchema.parse({
      branchNamingPattern: 'feature/builder/{summary}',
    });
    expect(parsed.branchNamingPattern).toBe('feature/builder/{summary}');
  });
});

describe('isOptedInToBuilder', () => {
  it('returns true when builderBotRef is set', () => {
    expect(isOptedInToBuilder({ builderBotRef: 'k' })).toBe(true);
  });

  it('returns false when builderBotRef is absent', () => {
    expect(isOptedInToBuilder({})).toBe(false);
  });
});

describe('validateBuilderAgentFields', () => {
  it('accepts an un-opted-in agent (no fields set)', () => {
    expect(() => validateBuilderAgentFields('winston', {})).not.toThrow();
  });

  it('accepts a fully-opted-in agent', () => {
    expect(() =>
      validateBuilderAgentFields('winston', {
        builderBotRef: 'k',
        operatorAllowlist: [],
        testableMechanism: { type: 'cache_refresh' },
      }),
    ).not.toThrow();
  });

  it('rejects opt-in missing operatorAllowlist', () => {
    expect(() =>
      validateBuilderAgentFields('winston', {
        builderBotRef: 'k',
        testableMechanism: { type: 'cache_refresh' },
      }),
    ).toThrow(/operatorAllowlist/);
  });

  it('rejects opt-in missing testableMechanism', () => {
    expect(() =>
      validateBuilderAgentFields('winston', {
        builderBotRef: 'k',
        operatorAllowlist: [],
      }),
    ).toThrow(/testableMechanism/);
  });

  it('error names both missing fields when both are absent', () => {
    expect(() =>
      validateBuilderAgentFields('winston', {
        builderBotRef: 'k',
      }),
    ).toThrow(/operatorAllowlist.*testableMechanism|testableMechanism.*operatorAllowlist/);
  });

  it('includes the agent name in the error message', () => {
    expect(() => validateBuilderAgentFields('winston', { builderBotRef: 'k' })).toThrow(/winston/);
  });
});

describe('agentEntrySchema integration', () => {
  it('parses an agent entry with no Builder fields', () => {
    const parsed = agentEntrySchema.parse({
      name: 'winston',
      repo: 'git@github.com:org/the-agency.git',
      path: 'agents/winston',
    });
    expect(parsed.builderBotRef).toBeUndefined();
  });

  it('parses an agent entry with full Builder opt-in', () => {
    const parsed = agentEntrySchema.parse({
      name: 'winston',
      repo: 'git@github.com:org/the-agency.git',
      path: 'agents/winston',
      builderBotRef: 'builder_bot_the_agency',
      operatorAllowlist: ['heather@example.com'],
      testableMechanism: {
        type: 'deploy_webhook',
        webhookUrl: 'https://supervisor.example.com/deploy-complete',
      },
    });
    expect(parsed.builderBotRef).toBe('builder_bot_the_agency');
    expect(parsed.operatorAllowlist).toEqual(['heather@example.com']);
  });
});
