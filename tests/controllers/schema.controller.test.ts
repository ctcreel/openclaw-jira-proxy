import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import {
  getRoutingSchemas,
  handleRoutingSchema,
  resetRoutingSchemaCache,
} from '../../src/controllers/schema.controller';

function buildResponseMock(): {
  json: (body: unknown) => void;
  jsonBody: { current: unknown };
} {
  const jsonBody: { current: unknown } = { current: undefined };
  return {
    json: (body: unknown): void => {
      jsonBody.current = body;
    },
    jsonBody,
  };
}

describe('schema.controller — routing JSON Schema', () => {
  beforeEach(() => {
    resetRoutingSchemaCache();
  });

  it('returns three named slices: condition, agentRule, agentConfig', () => {
    const schemas = getRoutingSchemas();
    expect(Object.keys(schemas).sort((left, right) => left.localeCompare(right))).toEqual([
      'agentConfig',
      'agentRule',
      'condition',
    ]);
  });

  it('condition schema includes the predicate vocabulary (equals, in, matches, exists, all_of, any_of, not)', () => {
    const { condition } = getRoutingSchemas();
    const serialized = JSON.stringify(condition);
    expect(serialized).toContain('equals');
    expect(serialized).toContain('all_of');
    expect(serialized).toContain('any_of');
    expect(serialized).toContain('any_item');
    expect(serialized).toContain('not');
  });

  it('agentRule schema documents the rule fields the UI needs (messageTemplate, tools, dispatches, inputs)', () => {
    const { agentRule } = getRoutingSchemas();
    const serialized = JSON.stringify(agentRule);
    expect(serialized).toContain('messageTemplate');
    expect(serialized).toContain('tools');
    expect(serialized).toContain('dispatches');
    expect(serialized).toContain('inputs');
    expect(serialized).toContain('condition');
  });

  it('agentConfig schema documents the top-level shape (routing, modelRules, memory)', () => {
    const { agentConfig } = getRoutingSchemas();
    const serialized = JSON.stringify(agentConfig);
    expect(serialized).toContain('routing');
    expect(serialized).toContain('modelRules');
    expect(serialized).toContain('memory');
  });

  it("caches schemas across calls so repeat requests don't rebuild", () => {
    const first = getRoutingSchemas();
    const second = getRoutingSchemas();
    expect(second).toBe(first);
  });

  it('handleRoutingSchema responds with the three-slice JSON object', () => {
    const responseMock = buildResponseMock();
    handleRoutingSchema({} as Request, responseMock as unknown as Response);
    const body = responseMock.jsonBody.current as Record<string, unknown>;
    expect(Object.keys(body).sort((left, right) => left.localeCompare(right))).toEqual([
      'agentConfig',
      'agentRule',
      'condition',
    ]);
  });
});
