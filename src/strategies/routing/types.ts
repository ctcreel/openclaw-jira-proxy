import { z } from 'zod';

import { conditionSchema } from './condition';

export const routingRuleSchema = z.object({
  condition: conditionSchema,
  agentId: z.string().min(1),
  messageTemplate: z.string().optional(),
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const routingConfigSchema = z
  .object({
    rules: z.array(routingRuleSchema).default([]),
    default: z.string().nullable().optional(),
  })
  .optional();

export type RoutingConfig = z.infer<typeof routingConfigSchema>;
