import { describe, it, expect } from 'vitest';

import { regexStrategy } from '../../../src/strategies/routing/regex';
import type { RoutingRule } from '../../../src/strategies/routing/types';

function createRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    strategy: 'regex',
    field: 'webhookEvent',
    pattern: '^jira:issue_updated$',
    agentId: 'patch',
    ...overrides,
  };
}

describe('regexStrategy', () => {
  it('should have the correct name', () => {
    expect(regexStrategy.name).toBe('regex');
  });

  it('should return agentId when pattern matches', () => {
    const payload = { webhookEvent: 'jira:issue_updated' };
    expect(regexStrategy.evaluate(payload, createRule())).toBe('patch');
  });

  it('should return null when pattern does not match', () => {
    const payload = { webhookEvent: 'jira:issue_created' };
    expect(regexStrategy.evaluate(payload, createRule())).toBeNull();
  });

  it('should support case-insensitive flag', () => {
    const payload = { webhookEvent: 'JIRA:ISSUE_UPDATED' };
    const rule = createRule({ flags: 'i' });
    expect(regexStrategy.evaluate(payload, rule)).toBe('patch');
  });

  it('should match when any array element matches the pattern', () => {
    const payload = { issue: { fields: { labels: ['infra', 'bug', 'devops'] } } };
    const rule = createRule({
      field: 'issue.fields.labels',
      pattern: 'infra|devops',
      agentId: 'sasha',
    });
    expect(regexStrategy.evaluate(payload, rule)).toBe('sasha');
  });

  it('should return null when no array element matches', () => {
    const payload = { issue: { fields: { labels: ['frontend', 'bug'] } } };
    const rule = createRule({
      field: 'issue.fields.labels',
      pattern: 'infra|devops',
      agentId: 'sasha',
    });
    expect(regexStrategy.evaluate(payload, rule)).toBeNull();
  });

  it('should return null when field does not exist', () => {
    expect(regexStrategy.evaluate({}, createRule())).toBeNull();
  });

  it('should return null when rule has no field', () => {
    expect(regexStrategy.evaluate({}, createRule({ field: undefined }))).toBeNull();
  });

  it('should return null when rule has no pattern', () => {
    expect(regexStrategy.evaluate({}, createRule({ pattern: undefined }))).toBeNull();
  });

  it('should support partial matches without anchors', () => {
    const payload = { webhookEvent: 'jira:issue_updated' };
    const rule = createRule({ pattern: 'issue' });
    expect(regexStrategy.evaluate(payload, rule)).toBe('patch');
  });
});
