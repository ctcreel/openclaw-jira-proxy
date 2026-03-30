import { readFile } from 'node:fs/promises';

import { getLogger } from '../lib/logging';

const logger = getLogger('session-monitor');

/** Minimum time between successive file reads. */
const POLL_INTERVAL_MS = 2_000;

/** Maximum total time to wait for a session to go idle. */
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/** A session is "idle" when updatedAt has not changed for this long. */
const DEFAULT_IDLE_THRESHOLD_MS = 600_000;

/** Shape of a single session entry in sessions.json. */
interface SessionEntry {
  readonly updatedAt?: number;
  readonly status?: string;
}

/** The top-level sessions.json is a plain key→value map. */
type SessionsFile = Readonly<Record<string, SessionEntry>>;

/** Options for {@link waitForSessionIdle}. */
export interface SessionIdleOptions {
  /** Absolute path to sessions.json. */
  readonly sessionsFilePath: string;
  /** The full session key (e.g. `agent:patch:hook:jira:spe-1234`). */
  readonly sessionKey: string;
  /** How long the session must be unchanged before it is considered idle. */
  readonly idleThresholdMs?: number;
  /** Total timeout (rejects with an error). */
  readonly timeoutMs?: number;
  /** External abort signal (e.g. for graceful shutdown). */
  readonly signal?: AbortSignal;
}

/**
 * Read the sessions file and return the entry for `sessionKey`, or undefined.
 *
 * Failures (missing file, parse errors) are logged and treated as "session
 * not found" so the caller keeps polling rather than crashing.
 */
async function readSessionEntry(
  filePath: string,
  sessionKey: string,
): Promise<SessionEntry | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as SessionsFile;
    return data[sessionKey];
  } catch (error) {
    logger.debug({ error, filePath }, 'Could not read sessions file');
    return undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Session monitor aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Poll sessions.json until the target session's `updatedAt` timestamp has
 * not changed for `idleThresholdMs`.
 *
 * This is the serialisation primitive: the BullMQ worker calls this after
 * firing a hook and holds the job open until the agent run goes idle.
 *
 * Resolution signals:
 * - `updatedAt` unchanged for ≥ idleThresholdMs  → resolves
 * - `status` becomes `"done"` or `"failed"`       → resolves immediately
 * - Total time exceeds `timeoutMs`                 → rejects
 * - `signal` aborted                               → rejects
 */
// noqa: NAMING001
export async function waitForSessionIdle(options: SessionIdleOptions): Promise<void> {
  const {
    sessionsFilePath,
    sessionKey,
    idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let lastSeenUpdatedAt: number | undefined;
  let idleSince: number | undefined;

  logger.info({ sessionKey, idleThresholdMs, timeoutMs }, 'Waiting for session idle');

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Session monitor aborted');
    }

    const entry = await readSessionEntry(sessionsFilePath, sessionKey);

    if (entry) {
      // Explicit terminal status → done immediately.
      if (entry.status === 'done' || entry.status === 'failed') {
        logger.info({ sessionKey, status: entry.status }, 'Session reached terminal status');
        return;
      }

      const currentUpdatedAt = entry.updatedAt;

      if (currentUpdatedAt !== lastSeenUpdatedAt) {
        // Activity detected — reset the idle clock.
        lastSeenUpdatedAt = currentUpdatedAt;
        idleSince = Date.now();
      } else if (idleSince !== undefined) {
        const idleDuration = Date.now() - idleSince;
        if (idleDuration >= idleThresholdMs) {
          logger.info(
            { sessionKey, idleDuration, lastSeenUpdatedAt },
            'Session idle threshold reached',
          );
          return;
        }
      }
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }

  throw new Error(`Session monitor timeout: ${sessionKey} did not go idle within ${timeoutMs}ms`);
}
