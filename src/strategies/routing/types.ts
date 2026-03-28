import { z } from 'zod';

export interface RoutingStrategy {
  readonly name: string;
  evaluate(payload: unknown, rule: RoutingRule): string | null;
}

export const routingRuleSchema = z.object({
  strategy: z.string().min(1),
  field: z.string().optional(),
  value: z.string().optional(),
  pattern: z.string().optional(),
  flags: z.string().optional(),
  agentId: z.string().min(1),
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const routingConfigSchema = z
  .object({
    rules: z.array(routingRuleSchema).default([]),
    default: z.string().optional(),
  })
  .optional();

export type RoutingConfig = z.infer<typeof routingConfigSchema>;
