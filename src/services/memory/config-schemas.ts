import { z } from 'zod';

import { parseDurationToMs } from '../../lib/duration';

/**
 * Agent-level memory configuration (top-level `memory:` block in
 * `clawndom.yaml`). Declares which namespaces this agent owns and
 * the per-namespace policy. The MemoryService is constructed from
 * these blocks at startup, with global registries used to resolve
 * `embeddingProvider` and `vectorStore` names.
 *
 * Pruning runs daily; entries with `last_accessed_at < now - pruneAfter`
 * are deleted. Default 365 days is generous — useful-but-rarely-accessed
 * memories survive as long as someone queries them at least annually.
 */
const namespacePolicySchema = z.object({
  embeddingProvider: z.string().min(1),
  vectorStore: z.string().min(1),
  pruneAfter: z
    .string()
    .min(1)
    .default('365d')
    .transform((value, ctx) => {
      try {
        return parseDurationToMs(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    }),
  maxStoresPerRun: z.number().int().positive().default(5),
});

export const agentMemorySchema = z.object({
  namespaces: z.record(z.string().min(1), namespacePolicySchema).default({}),
});

export type AgentMemoryConfig = z.infer<typeof agentMemorySchema>;
export type NamespacePolicy = z.infer<typeof namespacePolicySchema>;

/**
 * Per-rule retrieval config. When present on a routing rule, the worker
 * pre-fetches memories before template render and exposes them as
 * `{{ memories }}`. Storage on the same rule's namespace happens via
 * `agency_tools.memory.store()` from inside the agent's run; the route
 * doesn't need to declare anything for storage to work.
 */
const memoryRetrieveSchema = z.object({
  queryField: z.string().min(1),
  topK: z.number().int().positive(),
  minSimilarity: z.number().min(0).max(1),
});

export const ruleMemorySchema = z.object({
  namespace: z.string().min(1),
  retrieve: memoryRetrieveSchema.optional(),
});

export type RuleMemoryConfig = z.infer<typeof ruleMemorySchema>;
export type MemoryRetrieveConfig = z.infer<typeof memoryRetrieveSchema>;
