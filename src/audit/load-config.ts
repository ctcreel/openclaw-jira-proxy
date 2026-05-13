import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

import { modelRuleSchema } from '../config';
import { ruleMemorySchema, agentMemorySchema } from '../services/memory/config-schemas';
import { ruleToolsSchema } from '../services/tools/config-schemas';
import { conditionSchema } from '../strategies/routing';
import { sessionConfigSchema } from '../strategies/session-key';
import { runnerConfigSchema } from '../runners/types';

/**
 * The audit reads the same clawndom.yaml shape the runtime loads, but tolerates
 * partial schemas (a route can be valid even if memory provider strategies
 * aren't registered locally). The schema mirrors `agentConfigSchema` in
 * `agent-loader.service.ts` minus the registry-dependent cross-checks; the
 * registry checks happen at runtime, the audit's job is structural integrity.
 */
const auditRuleSchema = z.object({
  name: z.string().optional(),
  condition: conditionSchema.optional(),
  messageTemplate: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  catchUp: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  runner: runnerConfigSchema.optional(),
  memory: ruleMemorySchema.optional(),
  session: sessionConfigSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  tools: ruleToolsSchema.optional(),
  dispatches: z.array(z.string().min(1)).default([]),
  inputs: z.array(z.string().min(1)).default([]),
});

const auditRoutingSchema = z.object({
  rules: z.array(auditRuleSchema).default([]),
});

const auditConfigSchema = z.object({
  routing: z.record(z.string(), auditRoutingSchema).default({}),
  modelRules: z.record(z.string(), z.array(modelRuleSchema)).default({}),
  memory: agentMemorySchema.optional(),
});

export type AuditConfig = z.infer<typeof auditConfigSchema>;
export type AuditRule = z.infer<typeof auditRuleSchema>;

export interface LoadedConfig {
  readonly config: AuditConfig;
  readonly rawYaml: string;
  readonly configPath: string;
}

export async function loadAgentConfig(agentDir: string): Promise<LoadedConfig> {
  const configPath = join(agentDir, 'clawndom.yaml');
  const rawYaml = await readFile(configPath, 'utf-8');
  const parsed = parseYaml(rawYaml);
  const config = auditConfigSchema.parse(parsed);
  return { config, rawYaml, configPath };
}
