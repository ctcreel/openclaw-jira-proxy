import { describe, it, expect } from 'vitest';

import {
  computeToolName,
  buildInputSchema,
  normalizeSecrets,
  toolYamlSchema,
  type ArgumentDef,
} from '../../../src/services/tools/descriptor';

describe('computeToolName', () => {
  it.each([
    {
      label: 'joins the parent and tool segments with underscore',
      input: '/abs/agency_tools/slack/post',
      expected: 'slack_post',
    },
    {
      label: 'strips a "tools" parent segment',
      input: '/abs/winston_agent/tools/calendar_check',
      expected: 'calendar_check',
    },
    {
      label: 'returns just the leaf when there is no parent',
      input: '/standalone',
      expected: 'standalone',
    },
    {
      label: 'tolerates trailing slash',
      input: '/abs/agency_tools/slack/post/',
      expected: 'slack_post',
    },
    {
      label: 'returns empty string for an empty directory argument',
      input: '',
      expected: '',
    },
    {
      label: 'returns empty string for just a slash',
      input: '/',
      expected: '',
    },
  ])('$label', ({ input, expected }) => {
    expect(computeToolName(input)).toBe(expected);
  });
});

describe('buildInputSchema', () => {
  it('lists every arg in properties', () => {
    const args: Record<string, ArgumentDef> = {
      channel: { type: 'string', description: 'Slack channel ID' },
      text: { type: 'string', description: 'Message text' },
    };
    const schema = buildInputSchema(args);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['channel', 'text']);
    expect(schema.properties['channel']?.type).toBe('string');
  });

  it('includes args without optional:true in required', () => {
    const args: Record<string, ArgumentDef> = {
      channel: { type: 'string', description: 'Slack channel ID' },
      text: { type: 'string', description: 'Message text' },
      thread_ts: { type: 'string', description: 'Optional thread ts', optional: true },
    };
    const schema = buildInputSchema(args);
    expect(schema.required).toEqual(['channel', 'text']);
    expect(schema.required).not.toContain('thread_ts');
  });

  it('omits all from required when every arg is optional', () => {
    const args: Record<string, ArgumentDef> = {
      foo: { type: 'string', description: 'optional foo', optional: true },
    };
    const schema = buildInputSchema(args);
    expect(schema.required).toEqual([]);
  });
});

describe('toolYamlSchema', () => {
  it('accepts a minimal valid tool.yaml', () => {
    expect(() => toolYamlSchema.parse({ description: 'A tool' })).not.toThrow();
  });

  it('defaults args to empty map and secrets to empty map', () => {
    const parsed = toolYamlSchema.parse({ description: 'A tool' });
    expect(parsed.args).toEqual({});
    expect(parsed.secrets).toEqual({});
  });

  it('accepts secrets with a single string alias', () => {
    const parsed = toolYamlSchema.parse({
      description: 'A tool',
      secrets: { bot_token: 'SLACK_BOT_TOKEN' },
    });
    expect(parsed.secrets).toEqual({ bot_token: 'SLACK_BOT_TOKEN' });
  });

  it('accepts secrets with an array of aliases', () => {
    const parsed = toolYamlSchema.parse({
      description: 'A tool',
      secrets: { bot_token: ['SLACK_WINSTON_BOT_TOKEN', 'SLACK_BOT_TOKEN'] },
    });
    expect(parsed.secrets).toEqual({
      bot_token: ['SLACK_WINSTON_BOT_TOKEN', 'SLACK_BOT_TOKEN'],
    });
  });

  it('rejects an empty alias array', () => {
    expect(() =>
      toolYamlSchema.parse({ description: 'A tool', secrets: { bot_token: [] } }),
    ).toThrow();
  });

  it('rejects an empty alias string', () => {
    expect(() =>
      toolYamlSchema.parse({ description: 'A tool', secrets: { bot_token: '' } }),
    ).toThrow();
  });

  it('rejects a tool.yaml missing description', () => {
    expect(() => toolYamlSchema.parse({})).toThrow();
  });

  it('rejects an arg without type', () => {
    expect(() =>
      toolYamlSchema.parse({
        description: 'A tool',
        args: { channel: { description: 'no type field' } },
      }),
    ).toThrow();
  });

  it('rejects an arg without description', () => {
    expect(() =>
      toolYamlSchema.parse({
        description: 'A tool',
        args: { channel: { type: 'string' } },
      }),
    ).toThrow();
  });

  it('accepts an explicit name override', () => {
    const parsed = toolYamlSchema.parse({ description: 'A tool', name: 'custom_name' });
    expect(parsed.name).toBe('custom_name');
  });
});

describe('normalizeSecrets', () => {
  it('returns an empty array for an empty map', () => {
    expect(normalizeSecrets({})).toEqual([]);
  });

  it('wraps a single-string alias into a one-element list', () => {
    expect(normalizeSecrets({ bot_token: 'SLACK_BOT_TOKEN' })).toEqual([
      { canonical: 'bot_token', aliases: ['SLACK_BOT_TOKEN'] },
    ]);
  });

  it('copies an array form into the SecretSpecification aliases', () => {
    expect(
      normalizeSecrets({
        bot_token: ['SLACK_WINSTON_BOT_TOKEN', 'SLACK_BOT_TOKEN'],
      }),
    ).toEqual([
      {
        canonical: 'bot_token',
        aliases: ['SLACK_WINSTON_BOT_TOKEN', 'SLACK_BOT_TOKEN'],
      },
    ]);
  });

  it('preserves YAML map iteration order across multiple secrets', () => {
    const result = normalizeSecrets({
      first: 'A',
      second: 'B',
      third: 'C',
    });
    expect(result.map((s) => s.canonical)).toEqual(['first', 'second', 'third']);
  });
});
