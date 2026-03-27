interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly exponentialBase: number;
  readonly jitter: boolean;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1.0,
  maxDelay: 60.0,
  exponentialBase: 2.0,
  jitter: true,
};

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastException: Error;

  constructor(message: string, attempts: number, lastException: Error) {
    super(`${message} after ${attempts} attempts: ${lastException.message}`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastException = lastException;
  }
}

function calculateDelay(config: RetryConfig, attempt: number): number {
  let delay = config.baseDelay * Math.pow(config.exponentialBase, attempt - 1);
  delay = Math.min(delay, config.maxDelay);

  if (config.jitter) {
    const jitterRange = delay * 0.25;
    delay += (Math.random() * 2 - 1) * jitterRange;
  }

  return Math.max(0, delay);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function createRetryDecorator<TArgs extends unknown[], TReturn>(
  config?: Partial<RetryConfig>,
  options?: {
    retryableExceptions?: ReadonlyArray<new (...args: never[]) => Error>;
    onRetry?: (attempt: number, error: Error, delay: number) => void;
  },
): (fn: (...args: TArgs) => Promise<TReturn>) => (...args: TArgs) => Promise<TReturn> {
  const effectiveConfig: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  const retryableExceptions = options?.retryableExceptions ?? [Error];

  return (fn) => {
    return async (...args: TArgs): Promise<TReturn> => {
      let lastException: Error | null = null;

      for (let attempt = 1; attempt <= effectiveConfig.maxAttempts; attempt++) {
        try {
          return await fn(...args);
        } catch (error) {
          if (!(error instanceof Error)) throw error;

          const isRetryable = retryableExceptions.some((cls) => error instanceof cls);
          if (!isRetryable) throw error;

          lastException = error;

          if (attempt === effectiveConfig.maxAttempts) break;

          const delay = calculateDelay(effectiveConfig, attempt);
          console.warn(
            `Retry attempt ${attempt}/${effectiveConfig.maxAttempts} for ${fn.name}: ${error.message} (waiting ${delay.toFixed(2)}s)`,
          );

          options?.onRetry?.(attempt, error, delay);
          await sleep(delay);
        }
      }

      throw new RetryExhaustedError(
        `Function ${fn.name} failed`,
        effectiveConfig.maxAttempts,
        lastException ?? new Error('Unknown error'),
      );
    };
  };
}

export function createRetryForExceptions<TArgs extends unknown[], TReturn>(
  ...exceptions: Array<new (...args: never[]) => Error>
): (
  fn: (...args: TArgs) => Promise<TReturn>,
  config?: { maxAttempts?: number; baseDelay?: number; maxDelay?: number },
) => (...args: TArgs) => Promise<TReturn> {
  return (fn, config) => {
    return createRetryDecorator<TArgs, TReturn>(config, {
      retryableExceptions: exceptions.length > 0 ? exceptions : [Error],
    })(fn);
  };
}

export type { RetryConfig };
