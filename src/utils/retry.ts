import logger from '../logger';

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = 'operation',
  shouldRetry: ((error: Error) => boolean) | undefined = undefined
): Promise<T> {
  let lastError: Error | null = null;
  let delayMs = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.debug(`Retrying ${context} (attempt ${attempt + 1}/${config.maxRetries + 1}) after ${delayMs}ms`, {
          attempt: attempt + 1,
          maxRetries: config.maxRetries + 1,
          delayMs,
        });
      }
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if we should not retry this error
      if (shouldRetry && !shouldRetry(lastError)) {
        logger.debug(`${context} encountered non-retryable error, not retrying`, { error: lastError.message });
        throw lastError;
      }

      if (attempt === config.maxRetries) {
        logger.error(`${context} failed after ${attempt + 1} attempts`, {
          error: lastError.message,
          stack: lastError.stack,
        });
        throw lastError;
      }

      // Exponential backoff with jitter (±20%), but disable jitter in test mode for determinism
      let jitter = 0;
      if (process.env.NODE_ENV !== 'test') {
        jitter = delayMs * 0.2 * (Math.random() * 2 - 1);
      }
      const actualDelay = Math.min(delayMs + jitter, config.maxDelayMs);
      await sleep(actualDelay);
      delayMs = Math.min(delayMs * config.backoffFactor, config.maxDelayMs);
    }
  }

  // Should not reach here but for type safety
  throw lastError || new Error(`Unknown error in ${context}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  // SQLite specific errors
  if (message.includes('sqlite_busy') || message.includes('database is locked')) {
    return true;
  }
  // Network errors, timeouts, rate limits, connection resets
  const retryablePatterns = [
    'econnreset',
    'timeout',
    'rate limit',
    'too many requests',
    'service unavailable',
    'internal server error',
    'econnaborted',
    'network error',
  ];
  return retryablePatterns.some((pattern) => message.includes(pattern));
}
