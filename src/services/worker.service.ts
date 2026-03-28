import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { waitForSessionIdle } from './session-monitor.service';

const QUEUE_NAME = 'jira-webhooks';

const logger = getLogger('worker');

/**
 * Derive the session key that OpenClaw will write into sessions.json.
 *
 * The proxy tells OpenClaw to use `hook:jira:<issue-key>`.  OpenClaw
 * prefixes that with `agent:<agentId>:`, so the file-level key becomes
 * `agent:patch:hook:jira:spe-1234` (always lower-cased by the gateway).
 */
function buildSessionKey(payload: string, agentId: string): string {
  try {
    const data = JSON.parse(payload) as { issue?: { key?: string } };
    const issueKey = data.issue?.key?.toLowerCase() ?? 'unknown';
    return `agent:${agentId}:hook:jira:${issueKey}`;
  } catch {
    return `agent:${agentId}:hook:jira:unknown`;
  }
}

/**
 * Build the `sessionKey` value sent to OpenClaw in the POST body.
 * This is the *unprefixed* key — OpenClaw adds `agent:<id>:` itself.
 */
function buildHookSessionKey(payload: string): string {
  try {
    const data = JSON.parse(payload) as { issue?: { key?: string } };
    const issueKey = data.issue?.key?.toLowerCase() ?? 'unknown';
    return `hook:jira:${issueKey}`;
  } catch {
    return 'hook:jira:unknown';
  }
}

async function processJob(job: Job<string>, signal?: AbortSignal): Promise<void> {
  const settings = getSettings();
  const hookSessionKey = buildHookSessionKey(job.data);
  const fileSessionKey = buildSessionKey(job.data, settings.agentId);

  logger.info({ jobId: job.id, sessionKey: hookSessionKey }, 'Processing webhook job');

  const response = await fetch(settings.openclawHookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openclawToken}`,
    },
    body: JSON.stringify({
      message: job.data,
      agentId: settings.agentId,
      sessionKey: hookSessionKey,
      deliver: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenClaw returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { ok: boolean; runId: string };

  logger.info({ jobId: job.id, runId: body.runId, fileSessionKey }, 'Waiting for session idle');

  await waitForSessionIdle({
    sessionsFilePath: settings.sessionsFilePath,
    sessionKey: fileSessionKey,
    signal,
  });

  logger.info({ jobId: job.id, runId: body.runId }, 'Session idle — job complete');
}

export function createWorker(): Worker<string> {
  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

  const controller = new AbortController();

  const worker = new Worker<string>(QUEUE_NAME, (job) => processJob(job, controller.signal), {
    connection,
    concurrency: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Job failed');
  });

  // Graceful shutdown: abort in-flight polling, close the worker, then exit.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    controller.abort();
    await worker.close();
    await connection.quit();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return worker;
}
