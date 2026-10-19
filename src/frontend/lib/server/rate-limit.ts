interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  #nextSweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maximumBuckets = 10_000,
  ) {}

  consume(key: string): RateLimitResult {
    const now = this.now();
    if (now >= this.#nextSweepAt) {
      for (const [bucketKey, value] of this.#buckets) {
        if (value.resetAt <= now) this.#buckets.delete(bucketKey);
      }
      this.#nextSweepAt = now + Math.min(this.windowMs, 1_000);
    }
    const existing = this.#buckets.get(key);
    if (!existing && this.#buckets.size >= this.maximumBuckets) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    const bucket =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + this.windowMs }
        : existing;
    bucket.count += 1;
    this.#buckets.set(key, bucket);

    return {
      allowed: bucket.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    };
  }
}
