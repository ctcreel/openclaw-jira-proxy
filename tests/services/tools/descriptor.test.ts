import { describe, it, expect } from 'vitest';

import {
  deriveToolName,
  deriveInputSchema,
  toolYamlSchema,
  type ArgSpec,
} from '../../../src/services/tools/descriptor';

describe('deriveToolName', () => {
  it('joins the parent and tool segments with underscore', () => {
    expect(deriveToolName('/abs/agency_tools/slack/post')).toBe('slack_post');
  });

  it('strips a "tools" parent segment', () => {
    expect(deriveToolName('/abs/winston_agent/tools/calendar_check')).toBe('calendar_check');
  });

  it('returns just the leaf when there is no parent', () => {
    expect(deriveToolName('/standalone')).toBe('standalone');
  });

  it('tolerates trailing slash', () => {
    expect(deriveToolName('/abs/agency_tools/slack/post/')).toBe('slack_post');
  });
});

describe('deriveInputSchema', () => {
  it('lists every arg in properties', () => {
    const args: Record<string, ArgSpec> = {
      channel: { type: 'string', description: 'Slack channel ID' },
      text: { type: 'string', description: 'Message text' },
    };
    const schema = deriveInputSchema(args);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['channel', 'text']);
    expect(schema.properties.channel?.type).toBe('string');
  });

  it('includes args without optional:true in required', () => {
    const args: Record<string, ArgSpec> = {
      channel: { type: 'string', description: 'Slack channel ID' },
      text: { type: 'string', description: 'Message text' },
      thread_ts: { type: 'string', description: 'Optional thread ts', optional: true },
    };
    const schema = deriveInputSchema(args);
    expect(schema.required).toEqual(['channel', 'text']);
    expect(schema.required).not.toContain('thread_ts');
  });

  it('omits all from required when every arg is optional', () => {
    const args: Record<string, ArgSpec> = {
      foo: { type: 'string', description: 'optional foo', optional: true },
    };
    const schema = deriveInputSchema(args);
    expect(schema.required).toEqual([]);
  });
});

describe('toolYamlSchema', () => {
  it('accepts a minimal valid tool.yaml', () => {
    expect(() => toolYamlSchema.parse({ description: 'A tool' })).not.toThrow();
  });

  it('defaults args to empty map and requires to empty array', () => {
    const parsed = toolYamlSchema.parse({ description: 'A tool' });
    expect(parsed.args).toEqual({});
    expect(parsed.requires).toEqual([]);
  });

  it('accepts args with descriptions and types', () => {
    const parsed = toolYamlSchema.parse({
      description: 'A tool',
      args: { channel: { type: 'string', description: 'ID' } },
      requires: ['slack_bot_token'],
    });
    expect(parsed.args.channel?.type).toBe('string');
    expect(parsed.requires).toEqual(['slack_bot_token']);
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
