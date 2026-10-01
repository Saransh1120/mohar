/**
 * ── Rate limits ──────────────────────────────────────────────────────────────
 *
 * A token bucket per (limit, caller). `burst` is how many requests may arrive
 * at once; `perMinute` is how fast the allowance comes back. A caller who stays
 * under the rate never notices the limit, and one who exceeds it is told how
 * long to wait rather than being cut off for a fixed window.
 *
 * Counted in this process's memory. One gateway process is what this system
 * runs; a second one behind a load balancer would each keep their own count,
 * and the limits would have to move to Postgres before that is done.
 */

export interface LimitSpec {
  burst: number;
  perMinute: number;
}

export interface Taken {
  allowed: boolean;
  /** Whole requests still available after this one. */
  remaining: number;
  /** Seconds until one request is available again. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Refill is a float; a request due at exactly this instant must not miss by rounding. */
const EPSILON = 1e-9;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sinceSweep = 0;

  constructor(
    private readonly now: () => number = Date.now,
    /** Requests between sweeps of idle buckets. Bounds memory under a flood of keys. */
    private readonly sweepEvery = 5_000,
  ) {}

  private level(name: string, key: string, spec: LimitSpec): { id: string; tokens: number } {
    const id = `${name}\u0000${key}`;
    const b = this.buckets.get(id);
    if (!b) return { id, tokens: spec.burst };
    const refilled = b.tokens + ((this.now() - b.at) * spec.perMinute) / 60_000;
    return { id, tokens: Math.min(spec.burst, refilled) };
  }

  /** Spend one request from the caller's allowance, if there is one. */
  take(name: string, key: string, spec: LimitSpec): Taken {
    const { id, tokens } = this.level(name, key, spec);
    const allowed = tokens >= 1 - EPSILON;
    // A refusal leaves the bucket as it was. The refill is then always measured
    // from the last request that was let through, so a caller who keeps trying
    // while refused neither delays nor hastens their own return.
    if (allowed) this.buckets.set(id, { tokens: Math.max(0, tokens - 1), at: this.now() });
    if (++this.sinceSweep >= this.sweepEvery) this.sweep();
    return {
      allowed,
      remaining: Math.max(0, Math.floor(allowed ? tokens - 1 : tokens)),
      retryAfterSeconds: allowed ? 0 : this.waitSeconds(tokens, spec),
    };
  }

  /** Whether a request would be allowed, without spending it. */
  peek(name: string, key: string, spec: LimitSpec): Taken {
    const { tokens } = this.level(name, key, spec);
    const allowed = tokens >= 1 - EPSILON;
    return {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      retryAfterSeconds: allowed ? 0 : this.waitSeconds(tokens, spec),
    };
  }

  private waitSeconds(tokens: number, spec: LimitSpec): number {
    if (spec.perMinute <= 0) return 3600;
    return Math.max(1, Math.ceil(((1 - tokens) * 60) / spec.perMinute));
  }

  /**
   * Drop buckets that have refilled completely. A full bucket and a missing
   * one behave identically, so nothing is forgotten that mattered.
   */
  sweep(): void {
    this.sinceSweep = 0;
    const now = this.now();
    for (const [id, b] of this.buckets) {
      // Without the spec the refill rate is unknown, so idle is judged by time
      // alone: an hour untouched is longer than any limit here takes to refill.
      if (now - b.at > 3_600_000) this.buckets.delete(id);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
