import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/common';
import { BudgetService, RateLimitService, TAXONOMY_TTL_MS } from '../src/dm';
import { HealthService } from '../src/health/health.service';
import { SignalStatus } from '../src/persistence';
import { FakeConfigService, FakeSignalRepository } from './helpers/fakes';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const TONES = ['Professional', 'Humor'];

type TaxonomyShape = { categories: unknown[]; tones?: string[] };

/**
 * The /healthz report builder (architecture-spec.md §10), against the real
 * BudgetService over the in-memory ledger so the budget section is computed,
 * not stubbed.
 */
function setup(options: {
  reachable?: boolean;
  taxonomy?: TaxonomyShape | null;
  fromSnapshot?: boolean;
  ageMs?: number;
  budgetThrows?: boolean;
} = {}) {
  const clock = fixedClock(NOW);
  const config = new FakeConfigService({ dryRun: true, budgets: { manual: 50, search: 100 } });
  const signals = new FakeSignalRepository(clock);
  const budget = new BudgetService(config as never, signals as never);
  const taxonomyState =
    options.taxonomy === null
      ? null
      : {
          taxonomy: options.taxonomy ?? { categories: [{}, {}], tones: TONES },
          fetchedAt: new Date(NOW.getTime() - (options.ageMs ?? 0)),
          fromSnapshot: options.fromSnapshot ?? false,
        };
  const taxonomy = {
    peek: () => taxonomyState,
    ageMs: () => (taxonomyState ? options.ageMs ?? 0 : null),
  };
  const prisma = { isReachable: async () => options.reachable ?? true };
  const health = new HealthService(
    prisma as never,
    taxonomy as never,
    options.budgetThrows
      ? ({ usage: async () => Promise.reject(new Error('db')) } as never)
      : budget,
    new RateLimitService(clock),
    config as never,
    clock,
  );
  return { health, signals };
}

function seed(signals: FakeSignalRepository, id: string, status: string, adapterKey = 'manual') {
  signals.seed({ id, adapterKey, status, postedAt: new Date(NOW.getTime() - 60_000) });
}

describe('HealthService — status and issues', () => {
  it('is ok when the database is up and the taxonomy is fresh with tones', async () => {
    const report = await setup().health.report();
    expect(report.status).toBe('ok');
    expect(report.issues).toEqual([]);
    expect(report.taxonomy).toMatchObject({ available: true, categories: 2, tones: 2, stale: false });
  });

  it('is degraded solely for missing tones, and says so', async () => {
    const report = await setup({ taxonomy: { categories: [{}] } }).health.report();
    expect(report.status).toBe('degraded');
    expect(report.issues).toEqual(['taxonomy has no tones; tone gate skipped']);
    expect(report.taxonomy.tones).toBe(0);
  });

  it('reports no taxonomy at all', async () => {
    const report = await setup({ taxonomy: null }).health.report();
    expect(report.status).toBe('degraded');
    expect(report.issues).toEqual(['no taxonomy available']);
    expect(report.taxonomy.available).toBe(false);
  });

  it('reports a snapshot fallback and a stale taxonomy', async () => {
    expect((await setup({ fromSnapshot: true }).health.report()).issues).toEqual([
      'taxonomy served from persisted snapshot',
    ]);
    const stale = await setup({ ageMs: TAXONOMY_TTL_MS }).health.report();
    expect(stale.issues).toEqual(['taxonomy older than its TTL']);
    expect(stale.taxonomy.stale).toBe(true);
  });

  it('is down, with no budget section, when the database is unreachable', async () => {
    const report = await setup({ reachable: false }).health.report();
    expect(report.status).toBe('down');
    expect(report.issues).toContain('database unreachable');
    expect(report.budget).toBeNull();
  });

  it('says the budget could not be read rather than reporting zeros', async () => {
    const report = await setup({ budgetThrows: true }).health.report();
    expect(report.budget).toBeNull();
    expect(report.issues).toContain('budget usage could not be read');
  });
});

describe('HealthService — budget section', () => {
  it('lists the statuses it counts', async () => {
    const report = await setup().health.report();
    expect(report.budget?.counts).toEqual(['posted', 'dry_run']);
  });

  it('counts posted and dry_run per adapter, and nothing else', async () => {
    const { health, signals } = setup();
    seed(signals, 'p1', SignalStatus.POSTED);
    seed(signals, 'd1', SignalStatus.DRY_RUN);
    seed(signals, 'd2', SignalStatus.DRY_RUN, 'search');
    for (const status of [
      SignalStatus.SUPPRESSED,
      SignalStatus.REJECTED_SCHEMA,
      SignalStatus.REJECTED_TONE,
      SignalStatus.REJECTED_POLICY,
      SignalStatus.FAILED,
      SignalStatus.FAILED_PERMANENT,
    ]) {
      seed(signals, `x_${status}`, status);
    }

    const report = await health.report();

    expect(report.budget).toEqual({
      windowHours: 24,
      counts: ['posted', 'dry_run'],
      total: { used: 3, limit: 500 },
      byAdapter: { manual: { used: 2, limit: 50 }, search: { used: 1, limit: 100 } },
    });
  });

  it('surfaces an adapter that consumed quota without a configured budget', async () => {
    const { health, signals } = setup();
    seed(signals, 'r1', SignalStatus.DRY_RUN, 'rss');
    expect((await health.report()).budget?.byAdapter['rss']).toEqual({ used: 1, limit: 0 });
  });
});
