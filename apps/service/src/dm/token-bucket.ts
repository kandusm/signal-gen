/**
 * In-process token bucket.
 *
 * dm-contract.md asks the generator to "self-throttle rather than provoking
 * 429s". Capacity 10 with a 60s refill window matches DM's 10/min: a burst of
 * ten drains the bucket, after which tokens return continuously at one per six
 * seconds rather than in a spike on the minute boundary.
 *
 * In-process is sufficient because the service runs as a single machine
 * (build-plan.md §1, fly.toml `count = 1`). If that ever becomes more than
 * one, this has to move behind an advisory lock or a shared counter — the
 * daily budget is already DB-backed and would survive the change unaided.
 */
export class TokenBucket {
  /**
   * Refilling accumulates fractional tokens, so after draining the bucket and
   * waiting exactly one refill interval the arithmetic lands on
   * 0.9999999999999999 rather than 1. Without a tolerance the bucket would
   * withhold a token that is, by the contract, due — and would keep doing so
   * on every exact-interval boundary. The epsilon is far smaller than any
   * fraction of a token that could matter.
   */
  private static readonly EPSILON = 1e-9;

  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillWindowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** Takes one token if available. Returns false when the bucket is empty. */
  tryRemove(): boolean {
    this.refill();
    if (this.tokens < 1 - TokenBucket.EPSILON) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }

  /** Tokens currently available, for /healthz and diagnostics. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Milliseconds until at least one token is available; 0 when one is ready. */
  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1 - TokenBucket.EPSILON) return 0;
    const perTokenMs = this.refillWindowMs / this.capacity;
    return Math.ceil((1 - this.tokens) * perTokenMs);
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;

    const refilled = (elapsedMs / this.refillWindowMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillMs = nowMs;
  }
}
