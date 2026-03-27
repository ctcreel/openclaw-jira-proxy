import { describe, it, expect } from 'vitest';

import { createRetryDecorator, RetryExhaustedError } from '../../../src/lib/utils/retry';

describe('createRetryDecorator', () => {
  it('should return result on first success', async () => {
    const fn = async () => 42;
    const retryFn = createRetryDecorator({ maxAttempts: 3 })(fn);
    expect(await retryFn()).toBe(42);
  });

  it('should retry on failure and succeed', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    };
    const retryFn = createRetryDecorator({ maxAttempts: 3, baseDelay: 0.01 })(fn);
    expect(await retryFn()).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('should throw RetryExhaustedError when all attempts fail', async () => {
    const fn = async () => { throw new Error('always fails'); };
    const retryFn = createRetryDecorator({ maxAttempts: 2, baseDelay: 0.01 })(fn);
    await expect(retryFn()).rejects.toThrow(RetryExhaustedError);
  });
});
