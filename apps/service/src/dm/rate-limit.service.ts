import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, systemClock } from '../common';
import { TokenBucket } from './token-bucket';

/** DM's per-minute ceiling (dm-contract.md → Rate limits). */
export const DM_REQUESTS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

/**
 * The per-minute half of the rate contract. Separate from BudgetService
 * because it is in-process and instantaneous, whereas the daily budget is
 * DB-derived — they fail for different reasons and /healthz reports both.
 */
@Injectable()
export class RateLimitService {
  private readonly bucket: TokenBucket;

  constructor(@Optional() @Inject(CLOCK) now: Clock = systemClock) {
    this.bucket = new TokenBucket(DM_REQUESTS_PER_MINUTE, MINUTE_MS, () => now().getTime());
  }

  /** Takes a token. False means "not this minute" — the caller parks the row. */
  tryAcquire(): boolean {
    return this.bucket.tryRemove();
  }

  available(): number {
    return this.bucket.available();
  }

  msUntilNextToken(): number {
    return this.bucket.msUntilNextToken();
  }
}
