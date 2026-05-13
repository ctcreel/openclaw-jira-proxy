import type { JsonSchema } from './types';

/**
 * GitHub webhook payload shape — the unioned envelope across the
 * event types Clawndom routes today (check_suite, pull_request,
 * push, issue_comment, ...). Top-level `action` discriminates, but
 * routing rules condition on it as plain equality (`action = completed`)
 * rather than as a tagged union, so we model the union as an open
 * object with the actually-referenced fields typed.
 *
 * Currently anchored to Patch's `pr-broken` rule which matches
 * `check_suite.completed` failures. Add concrete sub-shapes as new
 * webhook event types come into routing.
 */
export const githubPayloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: 'Discriminator: `completed`, `opened`, `synchronize`, etc.',
    },
    repository: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        full_name: {
          type: 'string',
          description: 'owner/repo form (e.g. `SC0RED/Platform-Backend`).',
        },
        owner: {
          type: 'object',
          properties: {
            login: { type: 'string' },
            id: { type: 'integer' },
          },
          additionalProperties: true,
        },
        private: { type: 'boolean' },
        default_branch: { type: 'string' },
      },
      additionalProperties: true,
    },
    sender: {
      type: 'object',
      properties: {
        login: { type: 'string' },
        id: { type: 'integer' },
        type: { type: 'string' },
      },
      additionalProperties: true,
    },
    installation: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      additionalProperties: true,
    },
    check_suite: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        head_branch: { type: 'string' },
        head_sha: { type: 'string' },
        status: { type: 'string' },
        conclusion: {
          type: ['string', 'null'] as const,
          description:
            'success / failure / cancelled / neutral / skipped / timed_out / action_required',
        },
        app: {
          type: 'object',
          properties: { slug: { type: 'string' }, name: { type: 'string' } },
          additionalProperties: true,
        },
        pull_requests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              url: { type: 'string' },
              head: {
                type: 'object',
                properties: { sha: { type: 'string' }, ref: { type: 'string' } },
                additionalProperties: true,
              },
              base: {
                type: 'object',
                properties: { sha: { type: 'string' }, ref: { type: 'string' } },
                additionalProperties: true,
              },
            },
            additionalProperties: true,
          },
        },
        head_commit: {
          type: 'object',
          properties: { id: { type: 'string' }, message: { type: 'string' } },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    pull_request: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        state: { type: 'string' },
        title: { type: 'string' },
        body: { type: ['string', 'null'] as const },
        draft: { type: 'boolean' },
        merged: { type: 'boolean' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};
