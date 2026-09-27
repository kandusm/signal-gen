import { Injectable } from '@nestjs/common';
import type { AdapterKey } from '@signalgen/contract';
import { ConfigService } from '../config';
import { SignalRepository, type UsageCounts } from '../persistence';

export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export type BudgetDecision =
  | { allowed: true; usage: UsageCounts }
  | {
      allowed: false;
      reason: 'total_exhausted' | 'adapter_exhausted';
      limit: number;
      used: number;
      usage: UsageCounts;
    };

/**
 * The daily half of the rate contract: DM allows 500 requests/day per key.
 *
 * ## Why a trailing window, when dm-contract.md says "day"
 *
 * architecture-spec.md leaves OQ-3 open — whether DM's daily window is a
 * rolling 24h or a calendar day, and in which timezone. The Phase 0 brief
 * resolves it by counting a trailing 24h off the ledger, and that choice is
 * safe whichever way OQ-3 lands:
 *
 *   A trailing-24h cap of N can never permit more than N posts in any 24-hour
 *   span. A calendar-day cap of N can permit up to 2N — N at 23:59 and N again
 *   at 00:01. So trailing-24h usage is always a subset of what a calendar-day
 *   counter would allow, in every timezone.
 *
 * The cost is that we may throttle ourselves slightly early if DM really does
 * reset at midnight. At a 500/day ceiling against ~150/day of budgeted adapter
 * capacity, that headroom is not scarce, and the failure mode of guessing the
 * other way is a 429 storm and an alert per signal.
 *
 * Counting comes off the Signal ledger rather than a counter table, so it
 * cannot drift from what was actually posted — there is no increment to miss
 * on a crash.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly config: ConfigService,
    private readonly signals: SignalRepository,
  ) {}

  /** Posts inside the trailing window, total and per adapter. */
  usage(now: Date = new Date()): Promise<UsageCounts> {
    return this.signals.usageSince(new Date(now.getTime() - BUDGET_WINDOW_MS));
  }

  /**
   * Whether one more post from `adapterKey` fits inside both caps.
   * Checked before dispatch; a `false` leaves the row pending for the sweep.
   */
  async check(adapterKey: AdapterKey, now: Date = new Date()): Promise<BudgetDecision> {
    const usage = await this.usage(now);

    const totalLimit = this.config.totalBudget24h;
    if (usage.total >= totalLimit) {
      return { allowed: false, reason: 'total_exhausted', limit: totalLimit, used: usage.total, usage };
    }

    const adapterLimit = this.config.budgetFor(adapterKey);
    const adapterUsed = usage.byAdapter[adapterKey] ?? 0;
    if (adapterUsed >= adapterLimit) {
      return {
        allowed: false,
        reason: 'adapter_exhausted',
        limit: adapterLimit,
        used: adapterUsed,
        usage,
      };
    }

    return { allowed: true, usage };
  }
}
