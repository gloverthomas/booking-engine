/**
 * Small in-memory fixed-window rate limiter for the public API.
 *
 * TODO(integrator): state lives in one process, so with more than one web instance the effective
 * limit is `limit x instances` and a restart resets it. Swap `RateLimiter` for a shared store
 * (Postgres/Redis) behind the same `check` signature when the app scales out or abuse appears.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const PRUNE_THRESHOLD = 5_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const t = this.now();
    if (this.buckets.size > PRUNE_THRESHOLD) this.prune(t);

    const existing = this.buckets.get(key);
    const bucket: Bucket =
      existing && existing.resetAt > t ? existing : { count: 0, resetAt: t + this.windowMs };
    const next: Bucket = { count: bucket.count + 1, resetAt: bucket.resetAt };
    this.buckets.set(key, next);

    if (next.count > this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((next.resetAt - t) / 1000)),
      };
    }
    return { allowed: true, remaining: this.limit - next.count, retryAfterSec: 0 };
  }

  private prune(t: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(key);
    }
  }
}

export interface PublicLimiters {
  read: RateLimiter;
  availability: RateLimiter;
  hold: RateLimiter;
  mutate: RateLimiter;
}

/** Per-IP budgets. Holds and cancellations are the abuse targets, so they are tight. */
export function createPublicLimiters(now: () => number = Date.now): PublicLimiters {
  return {
    read: new RateLimiter(120, 60_000, now),
    availability: new RateLimiter(60, 60_000, now),
    hold: new RateLimiter(10, 10 * 60_000, now),
    mutate: new RateLimiter(15, 10 * 60_000, now),
  };
}
