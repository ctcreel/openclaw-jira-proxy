import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';
import WebSocket from 'ws';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';

const QUEUE_NAME = 'jira-webhooks';
const WEBSOCKET_TIMEOUT_MS = 30_000;

const logger = getLogger('worker');

function buildWebSocketUrl(hookUrl: string): string {
  const parsed = new URL(hookUrl);
  return `ws://${parsed.hostname}:${parsed.port}`;
}

function openSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForRunCompletion(socket: WebSocket, runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket timeout waiting for runId=${runId}`));
    }, WEBSOCKET_TIMEOUT_MS);

    socket.on('message', (data: WebSocket.RawData) => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        logger.debug({ text }, 'Non-JSON WS frame, ignoring');
        return;
      }

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'runId' in parsed &&
        'status' in parsed &&
        (parsed as Record<string, unknown>).runId === runId &&
        (parsed as Record<string, unknown>).status === 'done'
      ) {
        clearTimeout(timeout);
        resolve();
      }
    });

    socket.on('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function processJob(job: Job<string>): Promise<void> {
  const settings = getSettings();
  logger.info({ jobId: job.id }, 'Processing webhook job');

  const websocketUrl = buildWebSocketUrl(settings.openclawHookUrl);

  // Open WebSocket BEFORE firing the POST — this ensures we are subscribed
  // before OpenClaw can dispatch the run and emit 'done', eliminating the
  // race condition where a fast synchronous dispatch could fire the event
  // before our listener is attached.
  const socket = await openSocket(websocketUrl, settings.openclawToken);

  try {
    const response = await fetch(settings.openclawHookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openclawToken}`,
      },
      body: job.data,
    });

    if (!response.ok) {
      socket.close();
      throw new Error(`OpenClaw returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { ok: boolean; runId: string };
    const { runId } = body;

    logger.info({ jobId: job.id, runId }, 'Waiting for run completion');

    await waitForRunCompletion(socket, runId);

    logger.info({ jobId: job.id, runId }, 'Run completed');
  } finally {
    socket.close();
  }
}

export function createWorker(): Worker<string> {
  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<string>(QUEUE_NAME, processJob, {
    connection,
    concurrency: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Job failed');
  });

  return worker;
}
