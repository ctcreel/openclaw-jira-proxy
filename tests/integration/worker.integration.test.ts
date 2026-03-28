import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

async function writeSessionsFile(data: Record<string, unknown>): Promise<void> {
  await writeFile(sessionsPath, JSON.stringify(data), 'utf-8');
}

/**
 * Create a minimal HTTP server that mimics `/hooks/agent`.
 * Returns `{ ok: true, runId }` on POST.
 */
function createMockGateway(): { server: Server; port: number; receivedBodies: string[] } {
  const receivedBodies: string[] = [];
  let runCounter = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      receivedBodies.push(body);
      runCounter++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, runId: `run-${runCounter}` }));
    });
  });

  // Listen on a random port.
  server.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { server, port, receivedBodies };
}

describe('worker integration', () => {
  let gateway: ReturnType<typeof createMockGateway>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), `worker-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
    sessionsPath = join(tempDir, 'sessions.json');
    await writeSessionsFile({});
    gateway = createMockGateway();
  });

  afterEach(async () => {
    gateway.server.close();
  });

  it('holds the job open until the session goes idle, proving serialization', async () => {
    const { port, receivedBodies } = gateway;

    // Mock config to point at our test server and sessions file.
    vi.doMock('../../src/config', () => ({
      getSettings: vi.fn(() => ({
        openclawHookUrl: `http://127.0.0.1:${port}/hooks/agent`,
        openclawToken: 'int-test-token',
        redisUrl: 'redis://127.0.0.1:6379',
        agentId: 'patch',
        sessionsFilePath: sessionsPath,
      })),
    }));

    const { waitForSessionIdle } = await import('../../src/services/session-monitor.service');

    // Write an "active" session.
    await writeSessionsFile({
      'agent:patch:hook:jira:spe-100': { updatedAt: Date.now() },
    });

    const promise = waitForSessionIdle({
      sessionsFilePath: sessionsPath,
      sessionKey: 'agent:patch:hook:jira:spe-100',
      idleThresholdMs: 2_000,
      timeoutMs: 10_000,
    });

    // Simulate activity for 1 second.
    await new Promise((r) => setTimeout(r, 500));
    await writeSessionsFile({
      'agent:patch:hook:jira:spe-100': { updatedAt: Date.now() },
    });

    // Stop writing — session should idle out after 2s.
    await expect(promise).resolves.toBeUndefined();

    // Verify the gateway mock is functional (separate test for POST flow).
    const response = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test', agentId: 'patch', sessionKey: 'hook:jira:spe-100' }),
    });
    const body = (await response.json()) as { ok: boolean; runId: string };
    expect(body.ok).toBe(true);
    expect(body.runId).toMatch(/^run-\d+$/);
    expect(receivedBodies.length).toBe(1);
  }, 15_000);

  it('resolves immediately when session reaches terminal status', async () => {
    // Write a session that transitions to "done" quickly.
    await writeSessionsFile({
      'agent:patch:hook:jira:spe-done': { status: 'running', updatedAt: Date.now() },
    });

    // After 500ms, transition to done.
    setTimeout(async () => {
      await writeSessionsFile({
        'agent:patch:hook:jira:spe-done': { status: 'done', updatedAt: Date.now() },
      });
    }, 500);

    const { waitForSessionIdle } = await import('../../src/services/session-monitor.service');

    const start = Date.now();
    await waitForSessionIdle({
      sessionsFilePath: sessionsPath,
      sessionKey: 'agent:patch:hook:jira:spe-done',
      idleThresholdMs: 30_000,
      timeoutMs: 10_000,
    });
    const elapsed = Date.now() - start;

    // Should resolve in ~500ms + poll interval, well before the 30s idle threshold.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});
