import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ProviderConfig, ModelRule } from '../config';
import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { renderTemplate } from '../lib/template/template-engine';
import { extractWebhookContext } from '../strategies/context';
import { resolveAgentFromAgents, resolveFieldPath } from '../strategies/routing';
import type { AgentRule, ResolvedAgent } from './agent-loader.service';
import { getMemoryService } from './memory/memory.service';
import { renderRetrievePreamble, renderStorePostamble } from './memory/prompt-fragments';
import type { MemoryHit } from './memory/prompt-fragments';
import type { AlertRegistry } from './alerts';
import { getEventBus } from './event-bus.service';
import { getRunner } from '../runners/registry';
import { buildQueueName } from './queue.service';
import { buildFailedHandler } from './worker-failure-handler';
import { getSecretManager } from '../secrets/manager';

const logger = getLogger('worker');

const JobEnvelopeSchema = z.object({
  payload: z.string(),
  attempt: z.number(),
  originalJobId: z.string().optional(),
});

export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;

/**
 * Convert a logical secret key (e.g. "jira_patch_token" or "jira-patch-token")
 * into the env-var name injected into the runner subprocess.
 */
export function buildEnvVarNameForSecret(key: string): string {
  return key.replace(/[-.]/g, '_').toUpperCase();
}

/**
 * Resolve declared envSecrets from SecretManager into an env overlay.
 * Keys are upper-snake-cased; values are looked up synchronously.
 * Returns undefined when no envSecrets are declared so the runner can keep
 * its existing `env: process.env` fast path.
 */
export function resolveEnvSecrets(
  envSecrets: readonly string[] | undefined,
): Record<string, string> | undefined {
  if (!envSecrets || envSecrets.length === 0) {
    return undefined;
  }
  const secretManager = getSecretManager();
  const overlay: Record<string, string> = {};
  for (const key of envSecrets) {
    overlay[buildEnvVarNameForSecret(key)] = secretManager.getSecret(key);
  }
  return overlay;
}

/** Parse raw job data into an envelope. Re-enqueued jobs already have the envelope shape. */
export function parseEnvelope(data: string): JobEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { payload: data, attempt: 1 };
  }
  const result = JobEnvelopeSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  // Not an envelope — treat the raw data as a first-attempt payload
  return { payload: data, attempt: 1 };
}

export function resolveModel(
  payload: unknown,
  rules: ReadonlyArray<ModelRule> | undefined,
): string | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }

  for (const rule of rules) {
    const value = resolveFieldPath(payload, rule.field);
    if (value === undefined) {
      continue;
    }

    const matchTargets = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
    const fieldValues = Array.isArray(value) ? value : [value];

    const matched = fieldValues.some(
      (fieldValue) => typeof fieldValue === 'string' && matchTargets.includes(fieldValue),
    );

    if (matched) {
      return rule.model;
    }
  }

  return undefined;
}

export async function processJob(
  job: Job<string>,
  provider: ProviderConfig,
  agents: readonly ResolvedAgent[],
): Promise<void> {
  const settings = getSettings();
  const envelope = parseEnvelope(job.data);

  logger.info(
    {
      jobId: job.id,
      provider: provider.name,
      attempt: envelope.attempt,
      maxAttempts: settings.jobMaxAttempts,
    },
    'Processing webhook job',
  );

  // HMAC validation already succeeded in the controller, so the payload
  // is trusted. A JSON parse failure here is a real bug — let it throw
  // and surface via the worker's failure path rather than silently
  // routing an empty object.
  const parsedPayload: unknown = JSON.parse(envelope.payload);

  const webhookContext = extractWebhookContext(provider, parsedPayload);
  logger.info(
    {
      jobId: job.id,
      provider: provider.name,
      contextId: webhookContext.id,
      contextTitle: webhookContext.title,
      contextStatus: webhookContext.status,
      contextSource: webhookContext.source,
    },
    'Webhook context',
  );

  const resolved = resolveAgentFromAgents(parsedPayload, provider.name, agents);
  if (resolved === null) {
    logger.warn(
      { jobId: job.id, provider: provider.name },
      'routing:no-match — skipping forwarding',
    );
    return;
  }
  const { agentId, agentDir, messageTemplate: templatePath } = resolved;

  logger.info(
    { jobId: job.id, provider: provider.name, template: templatePath, agentId },
    'Routing matched',
  );

  const jobIdString = String(job.id ?? 'unknown');
  const traceId = envelope.originalJobId ?? jobIdString;
  const events = getEventBus();
  const matchedAgent = agents.find((agent) => agent.name === agentId);
  if (!matchedAgent) {
    throw new Error(`Routing resolved agentId "${agentId}" but that agent is not loaded`);
  }
  const modelRules = matchedAgent.config.modelRules[provider.name];
  const selectedModel = resolveModel(parsedPayload, modelRules);

  if (selectedModel) {
    logger.info(
      { jobId: job.id, provider: provider.name, model: selectedModel },
      'Model selected by routing rule',
    );
  }

  const memories = await fetchMemoriesForRule(resolved.rule, parsedPayload, traceId);
  if (memories !== undefined) {
    logger.info(
      {
        jobId: job.id,
        provider: provider.name,
        namespace: resolved.rule.memory?.namespace,
        hitCount: memories.length,
      },
      'Memories retrieved for template',
    );
  }

  let prompt: string;
  if (templatePath) {
    const templateContent = await readFile(join(agentDir, templatePath), 'utf-8');
    const renderedAgentBody = await renderTemplate(templateContent, parsedPayload, agentDir);
    prompt = wrapWithMemoryFragments(
      renderedAgentBody,
      resolved.rule.memory?.namespace,
      memories,
      traceId,
    );
  } else {
    prompt = envelope.payload;
  }

  const sessionKey = `agent:${agentId}:hook-${provider.name}-${traceId}`;
  const runnerName = provider.runner?.type ?? 'openclaw';
  const runner = getRunner(runnerName);

  const envOverlay = resolveEnvSecrets(provider.envSecrets);
  if (envOverlay) {
    // Log resolved key names at info level. Values are never logged —
    // the whole point of this path is to keep secrets out of transcripts.
    logger.info(
      {
        jobId: job.id,
        provider: provider.name,
        envSecretKeys: Object.keys(envOverlay),
      },
      'Injecting provider envSecrets into runner subprocess',
    );
  }

  // Prompt observability: hash at info level, full prompt at debug level
  const promptHash = createHash('sha256').update(prompt).digest('hex').slice(0, 12);
  logger.info(
    {
      jobId: job.id,
      provider: provider.name,
      runner: runnerName,
      sessionKey,
      promptHash,
      promptLength: prompt.length,
    },
    'Agent run delivered',
  );
  logger.debug(
    {
      jobId: job.id,
      provider: provider.name,
      runner: runnerName,
      sessionKey,
      prompt,
    },
    'Agent run prompt',
  );

  const jobStartedAt = Date.now();
  events.publish({
    type: 'job.started',
    timestamp: jobStartedAt,
    traceId,
    jobId: jobIdString,
    provider: provider.name,
    agentId,
    template: templatePath,
    runner: runnerName,
    model: selectedModel,
  });

  const result = await runner.run({
    prompt,
    sessionKey,
    agentId,
    model: selectedModel,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId,
    jobId: jobIdString,
    ...(envOverlay ? { env: envOverlay } : {}),
  });

  if (result.status === 'error') {
    throw new Error(`Agent run failed: ${result.error ?? 'unknown error'}`);
  }

  if (result.status === 'timeout') {
    throw new Error(`Agent run timed out (runId: ${result.runId})`);
  }

  // Dedup key intentionally NOT cleared here — let it expire naturally per
  // dedupTtlSeconds. Clearing it on completion lets Jira's webhook fan-out
  // (e.g. comment-added events that fire with the issue's prior status
  // snapshot ~1-2s after a transition) re-trigger Patch on the same
  // ticket+status, which costs a wasted Claude run. To re-trigger
  // intentionally, transition the ticket out of and back into the status
  // — the new event is past the dedup window.

  events.publish({
    type: 'job.completed',
    timestamp: Date.now(),
    traceId,
    jobId: jobIdString,
    provider: provider.name,
    durationMs: Date.now() - jobStartedAt,
    runId: result.runId ?? 'unknown',
  });

  logger.info(
    { jobId: job.id, provider: provider.name, sessionKey, runId: result.runId },
    'Agent run completed — job complete',
  );
}

export interface CreateWorkerOptions {
  provider: ProviderConfig;
  agents: readonly ResolvedAgent[];
  alertRegistry?: AlertRegistry;
}

export function createWorker(options: CreateWorkerOptions): Worker<string> {
  const { provider, agents, alertRegistry } = options;
  const settings = getSettings();
  const maxAttempts = settings.jobMaxAttempts;

  // One shared Redis connection for both the worker and the requeue Queue.
  // A prior implementation created a fresh connection per failure, which
  // under a bad-job storm leaked Redis sockets as fast as jobs failed.
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });
  const queueName = buildQueueName(provider.name);
  const requeueQueue = new Queue(queueName, { connection });

  const worker = new Worker<string>(queueName, (job) => processJob(job, provider, agents), {
    connection,
    concurrency: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });

  worker.on('failed', buildFailedHandler(provider, requeueQueue, alertRegistry, maxAttempts));

  logger.info({ provider: provider.name, queue: queueName, maxAttempts }, 'Worker started');
  return worker;
}

/**
 * Wrap the agent's rendered template with memory prompt fragments.
 *
 * When the matched rule declares a `memory.namespace`, prepend the
 * retrieve-preamble (with the pre-fetched hits interpolated) and append
 * the store-postamble (with namespace + traceId bound). The fragments
 * live in Clawndom and are uniform across agents — agent templates stay
 * focused on their domain logic; memory instructions are infrastructure.
 *
 * Returns the agent body unchanged when no memory namespace is set.
 */
function wrapWithMemoryFragments(
  agentBody: string,
  namespace: string | undefined,
  memories: readonly MemoryHit[] | undefined,
  traceId: string,
): string {
  if (namespace === undefined) {
    return agentBody;
  }
  const preamble = renderRetrievePreamble({
    memories: memories ?? [],
    memoryNamespace: namespace,
    traceId,
  });
  const postamble = renderStorePostamble({
    memories: memories ?? [],
    memoryNamespace: namespace,
    traceId,
  });
  return `${preamble}\n${agentBody}\n${postamble}`;
}

/**
 * Pre-render memory retrieval. When the matched rule has a
 * `memory.retrieve` block, resolve `queryField` against the parsed
 * payload, call MemoryService.search, return the hits for fragment
 * injection. Returns undefined when the rule has no retrieve config or
 * the field path doesn't yield a string.
 */
async function fetchMemoriesForRule(
  rule: AgentRule,
  parsedPayload: unknown,
  traceId: string,
): Promise<readonly MemoryHit[] | undefined> {
  const memoryConfig = rule.memory;
  if (memoryConfig === undefined || memoryConfig.retrieve === undefined) return undefined;

  const queryRaw = resolveFieldPath(parsedPayload, memoryConfig.retrieve.queryField);
  if (typeof queryRaw !== 'string' || queryRaw.length === 0) {
    logger.debug(
      {
        namespace: memoryConfig.namespace,
        queryField: memoryConfig.retrieve.queryField,
      },
      'Memory retrieve skipped — query field absent or non-string',
    );
    return undefined;
  }

  try {
    const result = await getMemoryService().search({
      namespace: memoryConfig.namespace,
      query: queryRaw,
      topK: memoryConfig.retrieve.topK,
      minSimilarity: memoryConfig.retrieve.minSimilarity,
      traceId,
    });
    return result.hits;
  } catch (error) {
    logger.error(
      {
        namespace: memoryConfig.namespace,
        error: error instanceof Error ? error.message : String(error),
      },
      'Memory retrieve failed — proceeding with empty memories',
    );
    return undefined;
  }
}
