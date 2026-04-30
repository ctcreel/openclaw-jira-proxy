import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'node:child_process';
import { OnePasswordProvider } from '../../src/secrets/onepassword.provider';
import type { SecretBinding } from '../../src/secrets/types';

describe('OnePasswordProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-op-token';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should have name "onepassword"', () => {
    const provider = new OnePasswordProvider({ type: 'onepassword' });
    expect(provider.name).toBe('onepassword');
  });

  it('should throw if OP_SERVICE_ACCOUNT_TOKEN is not set', () => {
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    expect(() => new OnePasswordProvider({ type: 'onepassword' })).toThrow(
      'OP_SERVICE_ACCOUNT_TOKEN is required',
    );
  });

  it('should resolve secrets via op read', async () => {
    // Mock execFile to simulate `op read` returning a value
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        if (args[0] === 'read') {
          callback!(null, { stdout: 'resolved-secret-value' });
        } else {
          callback!(null, { stdout: 'op 2.0.0' });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({ type: 'onepassword' });
    const bindings: SecretBinding[] = [
      {
        key: 'jira_hmac',
        provider: 'onepassword',
        reference: 'op://Clawndom/jira/hmac',
        required: true,
      },
    ];
    const result = await provider.resolve(bindings);
    expect(result.get('jira_hmac')).toBe('resolved-secret-value');
  });

  it('should omit secrets that fail to resolve', async () => {
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        callback!(new Error('item not found'), { stdout: '' });
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({ type: 'onepassword' });
    const bindings: SecretBinding[] = [
      {
        key: 'missing',
        provider: 'onepassword',
        reference: 'op://Clawndom/missing/field',
        required: true,
      },
    ];
    const result = await provider.resolve(bindings);
    expect(result.has('missing')).toBe(false);
  });
});
