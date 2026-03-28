import { describe, it, expect } from 'vitest';

import { fieldEqualsStrategy } from '../../../src/strategies/routing/field-equals';
import type { RoutingRule } from '../../../src/strategies/routing/types';

function createRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    strategy: 'field-equals',
    field: 'issue.fields.assignee.displayName',
    value: 'Patches',
    agentId: 'patch',
    ...overrides,
  };
}

describe('fieldEqualsStrategy', () => {
  it('should have the correct name', () => {
    expect(fieldEqualsStrategy.name).toBe('field-equals');
  });

  it('should return agentId when field value matches exactly', () => {
    const payload = { issue: { fields: { assignee: { displayName: 'Patches' } } } };
    expect(fieldEqualsStrategy.evaluate(payload, createRule())).toBe('patch');
  });

  it('should return null when field value does not match', () => {
    const payload = { issue: { fields: { assignee: { displayName: 'Someone' } } } };
    expect(fieldEqualsStrategy.evaluate(payload, createRule())).toBeNull();
  });

  it('should match when any array element equals the target', () => {
    const payload = { labels: ['infra', 'urgent'] };
    const rule = createRule({ field: 'labels', value: 'infra', agentId: 'sasha' });
    expect(fieldEqualsStrategy.evaluate(payload, rule)).toBe('sasha');
  });

  it('should return null when no array element matches', () => {
    const payload = { labels: ['frontend', 'bug'] };
    const rule = createRule({ field: 'labels', value: 'infra', agentId: 'sasha' });
    expect(fieldEqualsStrategy.evaluate(payload, rule)).toBeNull();
  });

  it('should return null when field path does not exist', () => {
    expect(fieldEqualsStrategy.evaluate({}, createRule())).toBeNull();
  });

  it('should return null when rule has no field', () => {
    expect(fieldEqualsStrategy.evaluate({}, createRule({ field: undefined }))).toBeNull();
  });

  it('should return null when rule has no value', () => {
    expect(fieldEqualsStrategy.evaluate({}, createRule({ value: undefined }))).toBeNull();
  });

  it('should coerce numeric values to string for comparison', () => {
    const payload = { status: 200 };
    const rule = createRule({ field: 'status', value: '200', agentId: 'monitor' });
    expect(fieldEqualsStrategy.evaluate(payload, rule)).toBe('monitor');
  });
});
