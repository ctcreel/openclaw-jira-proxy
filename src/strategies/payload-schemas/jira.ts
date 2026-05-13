import type { JsonSchema } from './types';

/**
 * Atlassian Jira webhook payload shape. Models the fields routing
 * rules condition against today (Patch's plan-*, ready-for-dev-*,
 * deploy-to-dev-*, verified-in-dev-* rules) plus the canonical
 * Atlassian envelope fields.
 *
 * `issue.fields` is open (`additionalProperties: true`) because Jira
 * tenants have customfield_NNNNN and other tenant-specific keys that
 * vary by deployment. The audit doesn't pretend to know every Jira
 * tenant's custom-field schema.
 */
export const jiraPayloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    webhookEvent: {
      type: 'string',
      description: 'Atlassian event identifier (e.g. `jira:issue_updated`, `comment_created`).',
    },
    timestamp: { type: 'integer' },
    user: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        displayName: { type: 'string' },
        emailAddress: { type: 'string' },
      },
      additionalProperties: true,
    },
    issue: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        key: { type: 'string', description: 'Issue key (e.g. SPE-1234).' },
        self: { type: 'string' },
        fields: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            description: { type: ['string', 'object', 'null'] as const },
            status: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                id: { type: 'string' },
              },
              additionalProperties: true,
            },
            issuetype: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Bug, Story, Task, Epic, etc.' },
                id: { type: 'string' },
                subtask: { type: 'boolean' },
              },
              additionalProperties: true,
            },
            priority: {
              type: 'object',
              properties: { name: { type: 'string' }, id: { type: 'string' } },
              additionalProperties: true,
            },
            assignee: {
              type: ['object', 'null'] as const,
              properties: {
                accountId: { type: 'string' },
                displayName: { type: 'string' },
                emailAddress: { type: 'string' },
              },
              additionalProperties: true,
            },
            reporter: {
              type: ['object', 'null'] as const,
              properties: {
                accountId: { type: 'string' },
                displayName: { type: 'string' },
                emailAddress: { type: 'string' },
              },
              additionalProperties: true,
            },
            labels: { type: 'array', items: { type: 'string' } },
            created: { type: 'string' },
            updated: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    changelog: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Name of the field that changed (e.g. `status`).',
              },
              fieldtype: { type: 'string' },
              fieldId: { type: 'string' },
              from: { type: ['string', 'null'] as const },
              fromString: { type: ['string', 'null'] as const },
              to: { type: ['string', 'null'] as const },
              toString: { type: ['string', 'null'] as const },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
    comment: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: ['string', 'object'] as const },
        author: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            displayName: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};
