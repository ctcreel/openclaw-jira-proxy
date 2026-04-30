import { describe, it, expect, beforeEach } from 'vitest';

import { ShellRunner } from '../../src/runners/shell.runner';
import type { RunOptions } from '../../src/runners/types';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type { ClawndomEvent } from '../../src/types/clawndom-event';

const baseOptions: RunOptions = {
  prompt: '',
  sessionKey: 'integration-shell',
  agentId: 'patch',
  timeoutMs: 60_000,
  traceId: 'integration-trace',
  jobId: 'integration-job',
};

function captureEvents(): ClawndomEvent[] {
  const events: ClawndomEvent[] = [];
  getEventBus().subscribe((e) => events.push(e));
  return events;
}

describe('ShellRunner — integration (real subprocess)', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('runs a real shell command, returns ok, and publishes tool_call → complete in order', async () => {
    const events = captureEvents();
    const runner = new ShellRunner(
      { type: 'shell', command: 'true', timeoutMs: 5_000 },
      process.cwd(),
    );

    const result = await runner.run(baseOptions);

    expect(result.status).toBe('ok');
    const types = events.map((e) => e.type);
    expect(types).toContain('runner.tool_call');
    expect(types).toContain('runner.complete');
    expect(types.indexOf('runner.tool_call')).toBeLessThan(types.indexOf('runner.complete'));
  });

  it('captures non-zero exit and surfaces the stderr tail in runner.error', async () => {
    const events = captureEvents();
    const runner = new ShellRunner(
      {
        type: 'shell',
        command: 'echo "boom" 1>&2 && exit 7',
        timeoutMs: 5_000,
      },
      process.cwd(),
    );

    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toContain('Shell exited with code 7');
    const errEvent = events.find((e) => e.type === 'runner.error');
    expect(errEvent).toBeDefined();
    expect(errEvent).toMatchObject({ reason: 'non-zero-exit', exitCode: 7 });
    expect((errEvent as { stderrTail: string }).stderrTail).toContain('boom');
  });

  it('enforces timeoutMs by signaling the process group and reporting status=timeout', async () => {
    const events = captureEvents();
    const runner = new ShellRunner(
      { type: 'shell', command: 'sleep 10', timeoutMs: 200 },
      process.cwd(),
    );

    const result = await runner.run(baseOptions);

    expect(result.status).toBe('timeout');
    const errEvent = events.find((e) => e.type === 'runner.error');
    expect(errEvent).toMatchObject({ reason: 'timeout' });
  }, 10_000);
});
