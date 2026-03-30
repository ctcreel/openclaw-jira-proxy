import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { waitForSessionIdle } from '../../src/services/session-monitor.service';

vi.mock('../../src/lib/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

let tempDir: string;
let sessionsPath: string;
let transcriptDir: string;

async function writeSessionsFile(data: Record<string, unknown>): Promise<void> {
  await writeFile(sessionsPath, JSON.stringify(data), 'utf-8');
}

async function writeTranscriptFile(sessionId: string, events: unknown[]): Promise<void> {
  const content = events.map((event) => JSON.stringify(event)).join('\n');
  await writeFile(join(transcriptDir, `${sessionId}.jsonl`), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `session-monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tempDir, { recursive: true });
  sessionsPath = join(tempDir, 'sessions.json');
  transcriptDir = join(tempDir, 'transcripts');
  await mkdir(transcriptDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session-monitor.service', () => {
  describe('waitForSessionIdle', () => {
    it('resolves immediately when session status is "done"', async () => {
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-1234': { status: 'done', updatedAt: 100 },
      });

      await expect(
        waitForSessionIdle({
          sessionsFilePath: sessionsPath,
          sessionKey: 'agent:patch:hook:jira:spe-1234',
          idleThresholdMs: 100,
          timeoutMs: 5_000,
        }),
      ).resolves.toBeUndefined();
    });

    it('resolves immediately when session status is "failed"', async () => {
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-1234': { status: 'failed', updatedAt: 100 },
      });

      await expect(
        waitForSessionIdle({
          sessionsFilePath: sessionsPath,
          sessionKey: 'agent:patch:hook:jira:spe-1234',
          idleThresholdMs: 100,
          timeoutMs: 5_000,
        }),
      ).resolves.toBeUndefined();
    });

    it('resolves after updatedAt stops changing for idleThresholdMs', async () => {
      const now = Date.now();
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-1234': { updatedAt: now },
      });

      const promise = waitForSessionIdle({
        sessionsFilePath: sessionsPath,
        sessionKey: 'agent:patch:hook:jira:spe-1234',
        idleThresholdMs: 3_000,
        timeoutMs: 15_000,
      });

      // Simulate activity for 2 seconds, then stop.
      await new Promise((r) => setTimeout(r, 1_000));
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-1234': { updatedAt: now + 1_000 },
      });

      // The idle threshold is 3s — after we stop writing, it should resolve
      // within ~3s + poll interval.
      await expect(promise).resolves.toBeUndefined();
    }, 15_000);

    it('rejects when timeout is exceeded', async () => {
      const now = Date.now();
      let counter = 0;

      // Keep the session "active" by continuously updating.
      const interval = setInterval(async () => {
        counter++;
        await writeSessionsFile({
          'agent:patch:hook:jira:spe-active': { updatedAt: now + counter * 1_000 },
        }).catch(() => {
          // Ignore write errors after cleanup
        });
      }, 500);

      try {
        await expect(
          waitForSessionIdle({
            sessionsFilePath: sessionsPath,
            sessionKey: 'agent:patch:hook:jira:spe-active',
            idleThresholdMs: 10_000,
            timeoutMs: 3_000,
          }),
        ).rejects.toThrow('Session monitor timeout');
      } finally {
        clearInterval(interval);
      }
    }, 10_000);

    it('rejects when abort signal is fired', async () => {
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-abort': { updatedAt: Date.now() },
      });

      const controller = new AbortController();

      const promise = waitForSessionIdle({
        sessionsFilePath: sessionsPath,
        sessionKey: 'agent:patch:hook:jira:spe-abort',
        idleThresholdMs: 60_000,
        timeoutMs: 60_000,
        signal: controller.signal,
      });

      // Abort after a short delay.
      setTimeout(() => controller.abort(), 500);

      await expect(promise).rejects.toThrow('Session monitor aborted');
    }, 5_000);

    it('handles missing sessions file gracefully and keeps polling', async () => {
      // File does not exist initially.
      const promise = waitForSessionIdle({
        sessionsFilePath: join(tempDir, 'nonexistent.json'),
        sessionKey: 'agent:patch:hook:jira:spe-missing',
        idleThresholdMs: 1_000,
        timeoutMs: 4_000,
      });

      await expect(promise).rejects.toThrow('Session monitor timeout');
    }, 10_000);

    it('handles malformed JSON gracefully and keeps polling', async () => {
      await writeFile(sessionsPath, '{ invalid json !!!', 'utf-8');

      const promise = waitForSessionIdle({
        sessionsFilePath: sessionsPath,
        sessionKey: 'agent:patch:hook:jira:spe-bad-json',
        idleThresholdMs: 1_000,
        timeoutMs: 3_000,
      });

      await expect(promise).rejects.toThrow('Session monitor timeout');
    }, 10_000);

    it('resolves when session transitions from running to done mid-poll', async () => {
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-transition': { status: 'running', updatedAt: Date.now() },
      });

      const promise = waitForSessionIdle({
        sessionsFilePath: sessionsPath,
        sessionKey: 'agent:patch:hook:jira:spe-transition',
        idleThresholdMs: 30_000,
        timeoutMs: 10_000,
      });

      // Transition to done after a short delay.
      setTimeout(async () => {
        await writeSessionsFile({
          'agent:patch:hook:jira:spe-transition': { status: 'done', updatedAt: Date.now() },
        });
      }, 1_500);

      await expect(promise).resolves.toBeUndefined();
    }, 10_000);

    it('does not declare idle when transcript shows toolResult pending', async () => {
      const sessionId = 'sess-thinking-001';
      const now = Date.now();

      await writeSessionsFile({
        'agent:patch:hook:jira:spe-thinking': {
          sessionId,
          updatedAt: now,
        },
      });

      // Transcript ends with toolResult — model is thinking.
      await writeTranscriptFile(sessionId, [
        { type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant' } },
        { type: 'message', message: { role: 'toolResult' } },
      ]);

      const promise = waitForSessionIdle({
        sessionsFilePath: sessionsPath,
        sessionKey: 'agent:patch:hook:jira:spe-thinking',
        transcriptDir,
        idleThresholdMs: 1_000,
        timeoutMs: 5_000,
      });

      // After 3s, update the transcript to show assistant response → now truly idle.
      setTimeout(async () => {
        await writeTranscriptFile(sessionId, [
          { type: 'message', message: { role: 'user' } },
          { type: 'message', message: { role: 'assistant' } },
          { type: 'message', message: { role: 'toolResult' } },
          { type: 'message', message: { role: 'assistant' } },
        ]);
      }, 3_000);

      await expect(promise).resolves.toBeUndefined();
    }, 15_000);

    it('declares idle normally when transcript shows assistant response', async () => {
      const sessionId = 'sess-idle-001';
      const now = Date.now();

      await writeSessionsFile({
        'agent:patch:hook:jira:spe-idle': {
          sessionId,
          updatedAt: now,
        },
      });

      // Transcript ends with assistant — model is done.
      await writeTranscriptFile(sessionId, [
        { type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant' } },
      ]);

      await expect(
        waitForSessionIdle({
          sessionsFilePath: sessionsPath,
          sessionKey: 'agent:patch:hook:jira:spe-idle',
          transcriptDir,
          idleThresholdMs: 2_000,
          timeoutMs: 10_000,
        }),
      ).resolves.toBeUndefined();
    }, 15_000);

    it('falls back to existing behavior when transcript file is missing', async () => {
      const now = Date.now();

      await writeSessionsFile({
        'agent:patch:hook:jira:spe-no-transcript': {
          sessionId: 'sess-missing-001',
          updatedAt: now,
        },
      });

      // No transcript file written — should fall back to updatedAt-only idle detection.
      await expect(
        waitForSessionIdle({
          sessionsFilePath: sessionsPath,
          sessionKey: 'agent:patch:hook:jira:spe-no-transcript',
          transcriptDir,
          idleThresholdMs: 2_000,
          timeoutMs: 10_000,
        }),
      ).resolves.toBeUndefined();
    }, 15_000);

    it('falls back to existing behavior when transcriptDir is not provided', async () => {
      const now = Date.now();

      await writeSessionsFile({
        'agent:patch:hook:jira:spe-no-dir': {
          sessionId: 'sess-nodir-001',
          updatedAt: now,
        },
      });

      await expect(
        waitForSessionIdle({
          sessionsFilePath: sessionsPath,
          sessionKey: 'agent:patch:hook:jira:spe-no-dir',
          idleThresholdMs: 2_000,
          timeoutMs: 10_000,
        }),
      ).resolves.toBeUndefined();
    }, 15_000);
  });
});
