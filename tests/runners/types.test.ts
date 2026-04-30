import { describe, it, expect } from 'vitest';

import { runnerConfigSchema } from '../../src/runners/types';

describe('runnerConfigSchema — shell variant', () => {
  it('accepts a minimal shell rule and applies the default timeoutMs', () => {
    const parsed = runnerConfigSchema.parse({ type: 'shell', command: 'echo hi' });
    expect(parsed).toMatchObject({ type: 'shell', command: 'echo hi', timeoutMs: 300_000 });
  });

  it('rejects a shell rule missing command', () => {
    const result = runnerConfigSchema.safeParse({ type: 'shell' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.format())).toContain('command');
    }
  });

  it('rejects a shell rule with a non-positive timeoutMs', () => {
    const result = runnerConfigSchema.safeParse({
      type: 'shell',
      command: 'echo hi',
      timeoutMs: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts cwd and env overrides', () => {
    const parsed = runnerConfigSchema.parse({
      type: 'shell',
      command: 'python3 ./script.py',
      cwd: '/some/dir',
      env: { TOKEN: 'abc' },
      timeoutMs: 5_000,
    });
    expect(parsed).toMatchObject({
      type: 'shell',
      command: 'python3 ./script.py',
      cwd: '/some/dir',
      env: { TOKEN: 'abc' },
      timeoutMs: 5_000,
    });
  });

  it('rejects an unknown runner type', () => {
    const result = runnerConfigSchema.safeParse({ type: 'unknown' });
    expect(result.success).toBe(false);
  });
});
