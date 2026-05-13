import type { JsonSchema } from './types';

/**
 * Internal-task dispatch payload. Shape is `{taskType, ...context}`
 * where the upstream rule's `dispatches:` declares the taskType
 * vocabulary and the receiving rule's `inputs:` declares the context
 * fields. Routing rules condition exclusively on `taskType` —
 * arbitrary context fields are accepted (additionalProperties: true)
 * because they vary per dispatch.
 */
export const internalPayloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    taskType: {
      type: 'string',
      description: 'The dispatched taskType — what routing.internal rules match on.',
    },
  },
  required: ['taskType'],
  additionalProperties: true,
};
