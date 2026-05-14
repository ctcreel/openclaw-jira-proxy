import type { JsonSchema } from './types';

/**
 * Schedule-fired event payload. Cron-driven rules don't carry an
 * inbound event body; the scheduler synthesises a minimal envelope
 * with the fire timestamp + the rule's cron spec for the audit log.
 * Routing rules don't typically condition on scheduled fires (the
 * cron itself is the trigger) but the schema exists so conditions
 * like `equals: { field: timezone, value: America/New_York }` can be
 * authored if needed.
 */
export const schedulePayloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    cron: {
      type: 'string',
      description: 'The cron expression of the firing rule (e.g. `0 6 * * 1-5`).',
    },
    timezone: { type: 'string', description: 'IANA timezone (e.g. `America/New_York`).' },
    firedAt: { type: 'integer', description: 'Epoch ms when the scheduler fired this rule.' },
    catchUp: {
      type: 'boolean',
      description: 'True when the fire is a make-up for a missed window.',
    },
  },
  additionalProperties: false,
};
