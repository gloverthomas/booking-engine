export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Whole seconds until the window resets (always at least 1 when blocked). */
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

/**
 * Fixed-window limiter, per key (a token id). In memory: with several server instances each one enforces its
 * own window, which is still a useful ceiling. The money caps are enforced from the database, not from here.
 */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => Date;
}): RateLimiter {
  const now = options.now ?? (() => new Date());
  const windows = new Map<string, { resetAt: number; count: number }>();
  return {
    check(key) {
      const t = now().getTime();
      if (windows.size > 5000) {
        for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      }
      const current = windows.get(key);
      const window =
        current && current.resetAt > t ? current : { resetAt: t + options.windowMs, count: 0 };
      window.count += 1;
      windows.set(key, window);
      const allowed = window.count <= options.limit;
      return {
        allowed,
        remaining: Math.max(0, options.limit - window.count),
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((window.resetAt - t) / 1000)),
      };
    },
  };
}
