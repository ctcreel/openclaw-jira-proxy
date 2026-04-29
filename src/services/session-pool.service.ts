import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type IORedis from 'ioredis';

import type { ProviderConfig } from '../config';
import { getLogger } from '../lib/logging';
import type { EventBus } from './event-bus.service';
import { getEventBus } from './event-bus.service';
import { getDedupRedis } from './dedup.service';
import type { SessionConfig, SessionKeyStrategy } from '../strategies/session-key';

import { parseStreamLine } from '../runners/claude-cli-stream-parser';
import type { StreamEvent } from '../runners/claude-cli-stream-parser';

/**
 * Owns the lifecycle of warm `claude-cli` subprocesses for session-aware
 * routes. One subprocess per session key (provider + strategy-derived id);
 * subsequent events for the same key feed `user_message` JSON over the
 * existing subprocess's stdin instead of paying spawn cost.
 *
 * Recovery story: session_id is captured from the first `init` event of
 * each fresh spawn and persisted to Redis with the configured TTL. After
 * idle reap or Clawndom restart, the next event for the key spawns
 * `claude --resume <id> ...` and conversation continuity is preserved.
 */

const logger = getLogger('session-pool');

const STARTUP_GRACE_MS = 15_000;
const REAP_GRACE_MS = 5_000;

type CliProcess = ChildProcessByStdio<Writable, Readable, Readable>;

interface ActiveSession {
  readonly providerName: string;
  readonly key: string;
  readonly child: CliProcess;
  sessionId: string | null;
  /** Promise chain — every queued turn awaits the previous one. */
  turnLock: Promise<void>;
  /** Last activity timestamp, refreshed after each turn completes. */
  lastActivity: number;
  /** Idle reap timer; reset after each turn. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Reading stdout — buffer for partial lines across chunks. */
  stdoutBuffer: string;
  /** Subscribers waiting for a result event to land. */
  pendingTurn: PendingTurn | null;
  /** Idle timeout for this session (from sessionConfig). */
  idleTimeoutMs: number;
  /** Has the subprocess emitted its init event yet? Resolves the readyPromise once true. */
  ready: boolean;
  /** Promise that resolves once the init event lands; rejects on early exit. */
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  /** Whether the runner expected a resume; used to detect mismatched session_id. */
  expectedSessionId: string | null;
  /** Cached events accumulated while a turn is in flight. */
  turnEvents: StreamEvent[];
}

interface PendingTurn {
  resolve: (events: StreamEvent[]) => void;
  reject: (error: Error) => void;
}

export interface SessionAcquireRequest {
  readonly providerName: string;
  readonly key: string;
  readonly providerConfig: ProviderConfig;
  readonly sessionConfig: SessionConfig;
  readonly workDirectory: string;
  readonly binary: string;
  readonly env?: Record<string, string>;
  readonly model?: string;
}

export interface SessionTurnHandle {
  readonly providerName: string;
  readonly key: string;
  readonly sessionId: string;
  /** Send a user message turn; resolves with the events emitted by the subprocess for this turn. */
  runTurn(userMessage: string): Promise<StreamEvent[]>;
}

export class SessionPool {
  private readonly active: Map<string, ActiveSession> = new Map();
  private readonly redis: IORedis;
  private readonly events: EventBus;
  private shuttingDown = false;

  constructor(options: { redis?: IORedis; events?: EventBus } = {}) {
    this.redis = options.redis ?? getDedupRedis();
    this.events = options.events ?? getEventBus();
  }

  /**
   * Acquire a turn handle for the given session key. Resolves once the
   * subprocess (warm or freshly-spawned-and-initialized) is ready to
   * accept a user_message turn.
   */
  async acquire(
    request: SessionAcquireRequest,
    strategy: SessionKeyStrategy,
  ): Promise<SessionTurnHandle> {
    if (this.shuttingDown) {
      throw new Error('SessionPool is shutting down — refusing new acquires.');
    }
    const compositeKey = buildCompositeKey(request.providerName, request.key);
    const existing = this.active.get(compositeKey);
    if (existing !== undefined && existing.child.exitCode === null) {
      return this.toHandle(existing);
    }

    // Either no entry, or entry is stale (subprocess exited). Drop stale
    // entry and (re)spawn.
    if (existing !== undefined) {
      this.active.delete(compositeKey);
    }

    const redisKey = buildRedisKey(request.providerName, request.key);
    const priorSessionId = await this.redis.get(redisKey);

    const session = await this.spawnSession(request, redisKey, priorSessionId, strategy);
    this.active.set(compositeKey, session);
    return this.toHandle(session);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const sessions = Array.from(this.active.values());
    this.active.clear();
    await Promise.all(sessions.map((s) => this.gracefullyClose(s)));
  }

  /** Live count of active subprocesses; useful for tests. */
  size(): number {
    return this.active.size;
  }

  private async spawnSession(
    request: SessionAcquireRequest,
    redisKey: string,
    priorSessionId: string | null,
    strategy: SessionKeyStrategy,
  ): Promise<ActiveSession> {
    const args = buildCliArgs(priorSessionId, request.model);
    const child = spawn(request.binary, args, {
      cwd: request.workDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: request.env ? { ...process.env, ...request.env } : process.env,
    }) as CliProcess;

    const session: ActiveSession = {
      providerName: request.providerName,
      key: request.key,
      child,
      sessionId: null,
      turnLock: Promise.resolve(),
      lastActivity: Date.now(),
      idleTimer: null,
      stdoutBuffer: '',
      pendingTurn: null,
      idleTimeoutMs: request.sessionConfig.idleTimeout,
      ready: false,
      readyPromise: undefined as unknown as Promise<void>,
      resolveReady: () => {},
      rejectReady: () => {},
      expectedSessionId: priorSessionId,
      turnEvents: [],
    };
    session.readyPromise = new Promise<void>((resolve, reject) => {
      session.resolveReady = resolve;
      session.rejectReady = reject;
    });

    this.attachStreamHandlers(session, redisKey, request, priorSessionId, strategy);

    // Surface logger context for this spawn.
    logger.info(
      {
        provider: session.providerName,
        key: session.key,
        mode: priorSessionId === null ? 'fresh' : 'resume',
        priorSessionId: priorSessionId ?? undefined,
      },
      'Spawning session subprocess',
    );

    // If the subprocess fails to emit its init event within the grace
    // window, reject the readyPromise. Stale-session fallback (resume
    // failed) is handled in the close handler below.
    const startupTimer = setTimeout(() => {
      if (!session.ready) {
        session.rejectReady(
          new Error(
            `claude-cli session spawn timed out after ${STARTUP_GRACE_MS}ms (no init event received)`,
          ),
        );
      }
    }, STARTUP_GRACE_MS);

    try {
      await session.readyPromise;
      clearTimeout(startupTimer);
      this.scheduleIdleReap(session);
      return session;
    } catch (error) {
      clearTimeout(startupTimer);
      // Stale resume — drop Redis key and respawn fresh.
      if (priorSessionId !== null) {
        await this.handleStaleResume(request, redisKey, priorSessionId, error, strategy);
        return this.spawnSession(request, redisKey, null, strategy);
      }
      // Fresh spawn that failed to initialize — propagate.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw error;
    }
  }

  private attachStreamHandlers(
    session: ActiveSession,
    redisKey: string,
    request: SessionAcquireRequest,
    priorSessionId: string | null,
    strategy: SessionKeyStrategy,
  ): void {
    session.child.stdout.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString();
      const lines = session.stdoutBuffer.split('\n');
      session.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (event === null) continue;
        this.handleStreamEvent(session, event, redisKey, request, priorSessionId, strategy);
      }
    });
    session.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length > 0) {
        logger.warn(
          { provider: session.providerName, key: session.key, stderr: text.slice(0, 500) },
          'Session subprocess stderr',
        );
      }
    });
    session.child.on('close', (code) => {
      this.events.publish({
        type: 'session.error',
        timestamp: Date.now(),
        traceId: session.providerName,
        provider: session.providerName,
        key: session.key,
        error_message: `subprocess exited with code ${code ?? 'null'}`,
      });
      logger.info(
        { provider: session.providerName, key: session.key, code },
        'Session subprocess closed',
      );
      // If a turn was in flight, fail it loudly.
      if (session.pendingTurn !== null) {
        session.pendingTurn.reject(
          new Error(`Session subprocess exited mid-turn (code ${code ?? 'null'})`),
        );
        session.pendingTurn = null;
      }
      // Drop the entry so the next acquire respawns from Redis.
      const compositeKey = buildCompositeKey(session.providerName, session.key);
      if (this.active.get(compositeKey) === session) {
        this.active.delete(compositeKey);
      }
      if (session.idleTimer !== null) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      // If close arrives before init, reject readyPromise.
      if (!session.ready) {
        session.rejectReady(
          new Error(`Session subprocess exited before init (code ${code ?? 'null'})`),
        );
      }
    });
    session.child.on('error', (error) => {
      logger.error(
        { provider: session.providerName, key: session.key, error: error.message },
        'Session subprocess spawn error',
      );
      if (!session.ready) {
        session.rejectReady(error);
      }
    });
  }

  private handleStreamEvent(
    session: ActiveSession,
    event: StreamEvent,
    redisKey: string,
    request: SessionAcquireRequest,
    priorSessionId: string | null,
    _strategy: SessionKeyStrategy,
  ): void {
    if (event.type === 'init') {
      // The CLI's stream-json `init` event carries `session_id` as a top-level
      // snake-case field; the StreamEvent schema is passthrough so we read it
      // via index access and narrow.
      const rawSessionId = (event as Record<string, unknown>)['session_id'];
      const initSessionId = typeof rawSessionId === 'string' ? rawSessionId : null;
      if (initSessionId === null) {
        logger.warn(
          { provider: session.providerName, key: session.key },
          'Init event missing session_id',
        );
        session.rejectReady(new Error('Init event without session_id'));
        return;
      }
      if (priorSessionId !== null && initSessionId !== priorSessionId) {
        logger.warn(
          {
            provider: session.providerName,
            key: session.key,
            priorSessionId,
            initSessionId,
          },
          'Resume returned mismatched session_id; treating as fresh',
        );
        this.events.publish({
          type: 'session.stale',
          timestamp: Date.now(),
          traceId: session.providerName,
          provider: session.providerName,
          key: session.key,
          prior_session_id: priorSessionId,
          reason: 'session_id mismatch on resume',
        });
      }
      session.sessionId = initSessionId;
      // Persist (or refresh) the session_id with the configured TTL.
      const ttlSeconds = Math.max(1, Math.floor(request.sessionConfig.ttl / 1000));
      this.redis.set(redisKey, initSessionId, 'EX', ttlSeconds).catch((error: unknown) => {
        logger.error(
          {
            provider: session.providerName,
            key: session.key,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to persist session_id to Redis',
        );
      });
      session.ready = true;
      session.resolveReady();
      if (priorSessionId === null) {
        this.events.publish({
          type: 'session.spawned',
          timestamp: Date.now(),
          traceId: session.providerName,
          provider: session.providerName,
          key: session.key,
          session_id: initSessionId,
          mode: 'fresh',
        });
      } else {
        this.events.publish({
          type: 'session.resumed',
          timestamp: Date.now(),
          traceId: session.providerName,
          provider: session.providerName,
          key: session.key,
          session_id: initSessionId,
          mode: 'resume',
        });
      }
      return;
    }
    // Non-init events are turn events; accumulate until a result lands.
    session.turnEvents.push(event);
    if (event.type === 'result') {
      const events = session.turnEvents;
      session.turnEvents = [];
      session.lastActivity = Date.now();
      this.scheduleIdleReap(session);
      if (session.pendingTurn !== null) {
        session.pendingTurn.resolve(events);
        session.pendingTurn = null;
      }
    }
  }

  private async handleStaleResume(
    request: SessionAcquireRequest,
    redisKey: string,
    priorSessionId: string,
    error: unknown,
    _strategy: SessionKeyStrategy,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      { provider: request.providerName, key: request.key, priorSessionId, reason },
      'Resume failed; falling back to fresh spawn',
    );
    this.events.publish({
      type: 'session.stale',
      timestamp: Date.now(),
      traceId: request.providerName,
      provider: request.providerName,
      key: request.key,
      prior_session_id: priorSessionId,
      reason,
    });
    try {
      await this.redis.del(redisKey);
    } catch (deleteError) {
      logger.warn(
        {
          provider: request.providerName,
          key: request.key,
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
        },
        'Failed to delete stale session_id from Redis',
      );
    }
  }

  private scheduleIdleReap(session: ActiveSession): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      void this.reapIdle(session);
    }, session.idleTimeoutMs);
  }

  private async reapIdle(session: ActiveSession): Promise<void> {
    if (session.pendingTurn !== null) {
      // Turn in flight; defer reap by rescheduling. (Should rarely happen
      // because lastActivity gets stamped after each result.)
      this.scheduleIdleReap(session);
      return;
    }
    const idleForMs = Date.now() - session.lastActivity;
    logger.info(
      { provider: session.providerName, key: session.key, idleForMs },
      'Reaping idle session',
    );
    this.events.publish({
      type: 'session.reaped',
      timestamp: Date.now(),
      traceId: session.providerName,
      provider: session.providerName,
      key: session.key,
      idle_for_ms: idleForMs,
    });
    await this.gracefullyClose(session);
  }

  private async gracefullyClose(session: ActiveSession): Promise<void> {
    if (session.child.exitCode !== null) return;
    try {
      session.child.stdin.end();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          session.child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          if (session.child.exitCode === null) {
            try {
              session.child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
          resolve();
        }, 1_000);
      }, REAP_GRACE_MS);
      session.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private toHandle(session: ActiveSession): SessionTurnHandle {
    return {
      providerName: session.providerName,
      key: session.key,
      get sessionId(): string {
        if (session.sessionId === null) {
          throw new Error('Session not initialized — handle accessed before init event landed');
        }
        return session.sessionId;
      },
      runTurn: async (userMessage: string): Promise<StreamEvent[]> => {
        // Per-key turn lock: chain through turnLock so concurrent runTurn
        // calls for the same session serialize.
        const previous = session.turnLock;
        let release: () => void = () => {};
        session.turnLock = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await this.executeTurn(session, userMessage);
        } finally {
          release();
        }
      },
    };
  }

  private executeTurn(session: ActiveSession, userMessage: string): Promise<StreamEvent[]> {
    if (session.pendingTurn !== null) {
      return Promise.reject(new Error('Internal error: pendingTurn not cleared'));
    }
    return new Promise<StreamEvent[]>((resolve, reject) => {
      session.pendingTurn = { resolve, reject };
      const envelope = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: userMessage },
      });
      try {
        session.child.stdin.write(envelope + '\n');
      } catch (error) {
        session.pendingTurn = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

function buildCompositeKey(providerName: string, key: string): string {
  return `${providerName}:${key}`;
}

function buildRedisKey(providerName: string, key: string): string {
  return `session:${providerName}:${key}`;
}

function buildCliArgs(resumeSessionId: string | null, model: string | undefined): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (resumeSessionId !== null) {
    args.push('--resume', resumeSessionId);
  } else {
    // Pre-generate a UUID? CLI emits its own; we capture from init event.
    // No --session-id flag → CLI generates one.
  }
  if (model !== undefined) {
    args.push('--model', model);
  }
  return args;
}

let singleton: SessionPool | null = null;

export function getSessionPool(): SessionPool {
  if (singleton === null) {
    singleton = new SessionPool();
  }
  return singleton;
}

/** Test-only: replace the singleton (e.g., with one wired to a fake Redis). */
export function setSessionPoolForTest(pool: SessionPool | null): void {
  singleton = pool;
}

/** Test-only export for sanity — building Redis key shape. */
export const _internals = { buildRedisKey, buildCompositeKey, buildCliArgs };
