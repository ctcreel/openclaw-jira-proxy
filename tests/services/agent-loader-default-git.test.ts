import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { defaultGitClient } from '../../src/services/agent-loader.service';

type ExecFileCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function recordExecFileCalls(): Array<readonly string[]> {
  const calls: Array<readonly string[]> = [];
  vi.mocked(execFile).mockImplementation(
    (
      _cmd: string,
      args: readonly string[] | undefined,
      optsOrCallback: unknown,
      maybeCallback?: ExecFileCallback,
    ) => {
      const callback =
        typeof optsOrCallback === 'function'
          ? (optsOrCallback as ExecFileCallback)
          : maybeCallback!;
      calls.push(args ?? []);
      callback(null, { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    },
  );
  return calls;
}

describe('defaultGitClient.clonePinned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clones, fetches with --tags, then resets to the ref (no origin/ prefix) when dir is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const calls = recordExecFileCalls();

    await defaultGitClient.clonePinned(
      'git@github.com:SC0RED/agency-tools.git',
      '/tmp/fake-shared-tools',
      'v1.0.0',
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      'clone',
      'git@github.com:SC0RED/agency-tools.git',
      '/tmp/fake-shared-tools',
    ]);
    expect(calls[1]).toEqual([
      '-C',
      '/tmp/fake-shared-tools',
      'fetch',
      '--prune',
      '--tags',
      'origin',
    ]);
    expect(calls[2]).toEqual(['-C', '/tmp/fake-shared-tools', 'reset', '--hard', 'v1.0.0']);
    expect(calls[2]).not.toContain('origin/v1.0.0');
  });

  it('skips clone, fetches with --tags, then resets when dir already exists', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const calls = recordExecFileCalls();

    await defaultGitClient.clonePinned(
      'git@github.com:SC0RED/agency-tools.git',
      '/tmp/fake-shared-tools',
      'abcdef0',
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-C',
      '/tmp/fake-shared-tools',
      'fetch',
      '--prune',
      '--tags',
      'origin',
    ]);
    expect(calls[1]).toEqual(['-C', '/tmp/fake-shared-tools', 'reset', '--hard', 'abcdef0']);
  });

  it('propagates the error when git fails (fail-fast on bad ref)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[] | undefined,
        optsOrCallback: unknown,
        maybeCallback?: ExecFileCallback,
      ) => {
        const callback =
          typeof optsOrCallback === 'function'
            ? (optsOrCallback as ExecFileCallback)
            : maybeCallback!;
        if (args?.includes('reset')) {
          callback(new Error("fatal: unknown revision 'v9.9.9'"), {
            stdout: '',
            stderr: '',
          });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    await expect(
      defaultGitClient.clonePinned(
        'git@github.com:SC0RED/agency-tools.git',
        '/tmp/fake-shared-tools',
        'v9.9.9',
      ),
    ).rejects.toThrow(/unknown revision/);
  });
});
