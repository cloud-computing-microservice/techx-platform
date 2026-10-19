import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "@/lib/server/rate-limit";

describe("fixed-window rate limiter", () => {
  it("bounds distinct clients without evicting active limits, then reclaims expired buckets", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(1, 10_000, () => now, 2);
    expect(limiter.consume("client-1").allowed).toBe(true);
    expect(limiter.consume("client-2").allowed).toBe(true);
    expect(limiter.consume("client-3").allowed).toBe(false);
    expect(limiter.consume("client-1").allowed).toBe(false);
    now = 11_001;
    expect(limiter.consume("client-3").allowed).toBe(true);
  });
  it("blocks after the limit and resets after the window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 10_000, () => now);
    expect(limiter.consume("client").allowed).toBe(true);
    expect(limiter.consume("client").allowed).toBe(true);
    const blocked = limiter.consume("client");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(10);
    now = 11_001;
    expect(limiter.consume("client").allowed).toBe(true);
  });
});
