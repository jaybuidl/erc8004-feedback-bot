import { withRetry, isRetryableError } from '../../src/utils/retry';

// Increase timeout for tests that use fake timers to avoid accidental timeouts
jest.setTimeout(10000);

describe('Retry Utils', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should succeed on first try', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 10000, backoffFactor: 2 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('should retry on failure and eventually succeed', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, initialDelayMs: 100, maxDelayMs: 10000, backoffFactor: 2 });

    // Run all pending timers to trigger the retry delay(s)
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('should fail after max retries exceeded', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent error'));

    const promise = withRetry(fn, { maxRetries: 2, initialDelayMs: 100, maxDelayMs: 10000, backoffFactor: 2 });

    // Attach a catch to prevent unhandled rejection warnings during timer advancement
    promise.catch(() => {});

    // Advance timers enough to cover all retry delays (100 + 200 = 300ms); use 1000ms for safety
    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).rejects.toThrow('persistent error');

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test('should respect isRetryableError patterns', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('timeout'))).toBe(true);
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('invalid argument'))).toBe(false);
  });
});