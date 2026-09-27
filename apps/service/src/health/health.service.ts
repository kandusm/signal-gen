import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, systemClock } from '../common';
import { ConfigService } from '../config';
import { BUDGET_WINDOW_MS, BudgetService, DM_REQUESTS_PER_MINUTE, RateLimitService, TAXONOMY_TTL_MS, TaxonomyService } from '../dm';
import { BUDGET_CONSUMING_STATUSES, PrismaService } from '../persistence';

export interface BudgetLine {
  used: number;
  limit: number;
}

export interface HealthReport {
  /** ok: everything nominal. degraded: usable but something is wrong. down: not usable. */
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  dryRun: boolean;
  database: { reachable: boolean };
  taxonomy: {
    available: boolean;
    fetchedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    fromSnapshot: boolean;
    categories: number;
    tones: number;
  };
  budget: {
    windowHours: number;
    /** Ledger states that `used` counts: posted and dry_run (Phase 1 brief §1). */
    counts: readonly string[];
    total: BudgetLine;
    byAdapter: Record<string, BudgetLine>;
  } | null;
  rateLimit: { perMinute: number; tokensAvailable: number };
  /** Human-readable reasons behind a non-ok status. */
  issues: string[];
}

/**
 * Assembles the truthful state of the service for /healthz
 * (architecture-spec.md section 10).
 *
 * "Truthful" is doing real work here: every field is measured at request time
 * rather than cached, and a section that cannot be computed reports that it
 * could not, instead of reporting a zero that reads like good news. An empty
 * budget and an unreadable budget look identical otherwise, and they mean
 * opposite things.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly budget: BudgetService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async report(): Promise<HealthReport> {
    const checkedAt = this.now();
    const issues: string[] = [];

    const databaseReachable = await this.prisma.isReachable();
    if (!databaseReachable) issues.push('database unreachable');

    // peek() rather than get(): /healthz reports the cache, it does not warm
    // it. A health check that triggers an outbound fetch turns a DM outage
    // into a slow health check and then a killed machine.
    const state = this.taxonomy.peek();
    const ageMs = this.taxonomy.ageMs();
    const stale = ageMs !== null && ageMs >= TAXONOMY_TTL_MS;

    if (!state) issues.push('no taxonomy available');
    else if (state.fromSnapshot) issues.push('taxonomy served from persisted snapshot');
    else if (stale) issues.push('taxonomy older than its TTL');
    // Independent of freshness: a taxonomy can be current and still carry no
    // tones, and then the tone gate is being skipped on every signal.
    if (state && !state.taxonomy.tones) issues.push('taxonomy has no tones; tone gate skipped');

    let budget: HealthReport['budget'] = null;
    if (databaseReachable) {
      try {
        const usage = await this.budget.usage(checkedAt);
        const byAdapter: Record<string, BudgetLine> = {};
        for (const adapterKey of this.config.budgetedAdapterKeys) {
          byAdapter[adapterKey] = {
            used: usage.byAdapter[adapterKey] ?? 0,
            limit: this.config.budgetFor(adapterKey),
          };
        }
        // Surface any adapter that posted without a configured budget; it
        // would otherwise be invisible in this report.
        for (const [adapterKey, used] of Object.entries(usage.byAdapter)) {
          byAdapter[adapterKey] ??= { used, limit: this.config.budgetFor(adapterKey) };
        }
        budget = {
          windowHours: BUDGET_WINDOW_MS / 3_600_000,
          counts: BUDGET_CONSUMING_STATUSES,
          total: { used: usage.total, limit: this.config.totalBudget24h },
          byAdapter,
        };
      } catch {
        issues.push('budget usage could not be read');
      }
    }

    return {
      status: !databaseReachable ? 'down' : issues.length > 0 ? 'degraded' : 'ok',
      checkedAt: checkedAt.toISOString(),
      dryRun: this.config.dryRun,
      database: { reachable: databaseReachable },
      taxonomy: {
        available: state !== null,
        fetchedAt: state?.fetchedAt.toISOString() ?? null,
        ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
        stale,
        fromSnapshot: state?.fromSnapshot ?? false,
        categories: state?.taxonomy.categories.length ?? 0,
        tones: state?.taxonomy.tones?.length ?? 0,
      },
      budget,
      rateLimit: {
        perMinute: DM_REQUESTS_PER_MINUTE,
        tokensAvailable: this.rateLimit.available(),
      },
      issues,
    };
  }
}
