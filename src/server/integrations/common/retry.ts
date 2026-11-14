import { RateLimitedError } from "./errors";

export interface BackoffOptions {
  /** Longest Retry-After we are willing to sit out inside one job (seconds). */
  maxWaitSec?: number;
  /** Total attempts including the first. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Retries when the provider answers 429, waiting as long as Retry-After says. A long wait (for
 * example the daily limit) is not sat out here: the error propagates so the queue retries the
 * job later with its own backoff.
 */
export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const { maxWaitSec = 60, attempts = 3, sleep = defaultSleep } = options;
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof RateLimitedError &&
        error.retryAfterSec <= maxWaitSec &&
        attempt < attempts;
      if (!retryable) throw error;
      await sleep(Math.max(1, error.retryAfterSec) * 1000);
      attempt += 1;
    }
  }
}

type AsyncFn = (...args: never[]) => Promise<unknown>;

/** Wraps every method of a port object with `withRateLimitRetry`. */
export function withBackoff<T extends { [K in keyof T]: AsyncFn }>(
  port: T,
  options: BackoffOptions = {},
): T {
  const wrapped = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(port) as Array<[string, AsyncFn]>) {
    wrapped[name] = (...args: never[]) => withRateLimitRetry(() => fn.apply(port, args), options);
  }
  return wrapped as T;
}
