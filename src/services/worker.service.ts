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
import { getSessionKeyStrategy } from '../strategies/session-key';
import type { AgentRule, ResolvedAgent } from './agent-loader.service';
import type { AlertRegistry } from './alerts';
import { getEventBus } from './event-bus.service';
import { getRunner } from '../runners/registry';
import { buildQueueName } from './queue.service';
import { buildFailedHandler } from './worker-failure-handler';
import { getSecretManager } from '../secrets/manager';
import type { AgentRunner, RunOptions, RunResult } from '../runners/types';
import type { SessionConfig, SessionKeyStrategy } from '../strategies/session-key';

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

  let prompt: string;
  if (templatePath) {
    const templateContent = await readFile(join(agentDir, templatePath), 'utf-8');
    prompt = await renderTemplate(templateContent, parsedPayload, agentDir);
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

  const result = await dispatchToRunner(runner, {
    prompt,
    sessionKey,
    agentId,
    model: selectedModel,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId,
    jobId: jobIdString,
    ...(envOverlay ? { env: envOverlay } : {}),
    sessionDispatch: buildSessionDispatch(provider, parsedPayload, resolved.rule),
    // For session-aware turns: warm/resume turns only send the new event's
    // raw payload — the template's instructions are already in the
    // subprocess's session JSONL from the first turn. The dispatcher passes
    // `prompt` as firstTurnPrompt (full template, used on fresh spawn) and
    // this string as userMessage (used on warm/resume).
    sessionUserMessage: envelope.payload,
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

/**
 * Per-job session dispatch info, when the matched routing rule has opted in
 * via a `session` block. `null` means dispatch through the existing per-event
 * `runner.run()` path.
 */
interface SessionDispatch {
  sessionKey: string;
  strategy: SessionKeyStrategy;
  config: SessionConfig;
  providerConfig: ProviderConfig;
}

/**
 * Resolve the session key for this event if the matched rule opted in.
 * Returns null when the rule has no session config, when the runner doesn't
 * support session-aware mode, or when the strategy declines (fall back to
 * the per-event-spawn path).
 */
function buildSessionDispatch(
  provider: ProviderConfig,
  parsedPayload: unknown,
  rule: AgentRule,
): SessionDispatch | null {
  if (rule.session === undefined) return null;
  const strategy = getSessionKeyStrategy(rule.session.strategy);
  if (strategy === undefined) {
    // Should be impossible if validateSessionConfig ran at startup, but
    // belt-and-suspenders for the loaded-after-startup case.
    logger.warn(
      { provider: provider.name, strategy: rule.session.strategy },
      'Unknown session strategy — falling back to per-event spawn',
    );
    return null;
  }
  const sessionKey = strategy.extract(parsedPayload, provider);
  if (sessionKey === null) {
    return null;
  }
  return {
    sessionKey,
    strategy,
    config: rule.session,
    providerConfig: provider,
  };
}

/**
 * Dispatch through `runner.runSession()` when a session is configured AND
 * the runner supports session mode; otherwise fall through to `runner.run()`.
 *
 * The session-aware path passes the rendered prompt as `firstTurnPrompt`
 * (used only on fresh spawns) and as `userMessage` (used on warm/resume
 * turns). The runner picks the right one via the handle's `acquirePath`.
 */
async function dispatchToRunner(
  runner: AgentRunner,
  options: RunOptions & {
    sessionDispatch: SessionDispatch | null;
    sessionUserMessage: string;
  },
): Promise<RunResult> {
  const { sessionDispatch, sessionUserMessage, ...runOptions } = options;
  if (sessionDispatch === null || runner.runSession === undefined) {
    if (sessionDispatch !== null && runner.runSession === undefined) {
      logger.warn(
        { runner: runner.name, sessionKey: sessionDispatch.sessionKey },
        'Runner does not support session mode — dispatching via run()',
      );
    }
    return runner.run(runOptions);
  }
  logger.info(
    {
      runner: runner.name,
      provider: sessionDispatch.providerConfig.name,
      sessionKey: sessionDispatch.sessionKey,
      strategy: sessionDispatch.strategy.name,
    },
    'Dispatching via session-aware runner',
  );
  return runner.runSession({
    providerName: sessionDispatch.providerConfig.name,
    providerConfig: sessionDispatch.providerConfig,
    sessionKey: sessionDispatch.sessionKey,
    strategy: sessionDispatch.strategy,
    sessionConfig: sessionDispatch.config,
    firstTurnPrompt: runOptions.prompt,
    userMessage: sessionUserMessage,
    agentId: runOptions.agentId,
    ...(runOptions.model !== undefined ? { model: runOptions.model } : {}),
    timeoutMs: runOptions.timeoutMs,
    ...(runOptions.traceId !== undefined ? { traceId: runOptions.traceId } : {}),
    ...(runOptions.jobId !== undefined ? { jobId: runOptions.jobId } : {}),
    ...(runOptions.env !== undefined ? { env: runOptions.env } : {}),
  });
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
