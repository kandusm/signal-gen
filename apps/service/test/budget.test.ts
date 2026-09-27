import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/common';
import { BUDGET_WINDOW_MS, BudgetService } from '../src/dm';
import { SignalStatus } from '../src/persistence';
import { FakeConfigService, FakeSignalRepository } from './helpers/fakes';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function setup(options: { total?: number; budgets?: Record<string, number> } = {}) {
  const clock = fixedClock(NOW);
  const signals = new FakeSignalRepository(clock);
  const config = new FakeConfigService({
    totalBudget24h: options.total ?? 500,
    budgets: options.budgets ?? { manual: 50, search: 100 },
  });
  const budget = new BudgetService(config as never, signals as never);
  return { clock, signals, config, budget };
}

/** Seeds `count` posted rows for an adapter, all posted `agoMs` ago. */
function seedPosted(
  signals: FakeSignalRepository,
  adapterKey: string,
  count: number,
  agoMs: number,
): void {
  for (let i = 0; i < count; i += 1) {
    signals.seed({
      id: `${adapterKey}_${agoMs}_${i}`,
      adapterKey,
      status: SignalStatus.POSTED,
      postedAt: new Date(NOW.getTime() - agoMs),
    });
  }
}

describe('BudgetService — trailing 24h counting', () => {
  it('counts only posted rows', async () => {
    const { signals, budget } = setup();
    seedPosted(signals, 'manual', 3, 60_000);

    // Rows in every other state make no DM request and consume no quota.
    for (const status of [
      SignalStatus.PENDING,
      SignalStatus.DRY_RUN,
      SignalStatus.FAILED,
      SignalStatus.FAILED_PERMANENT,
      SignalStatus.REJECTED_SCHEMA,
      SignalStatus.REJECTED_TONE,
      SignalStatus.SUPPRESSED,
    ]) {
      signals.seed({
        id: `other_${status}`,
        adapterKey: 'manual',
        status,
        postedAt: new Date(NOW.getTime() - 60_000),
      });
    }

    const usage = await budget.usage(NOW);
    expect(usage.total).toBe(3);
    expect(usage.byAdapter['manual']).toBe(3);
  });

  it('breaks usage out per adapter', async () => {
    const { signals, budget } = setup();
    seedPosted(signals, 'manual', 4, 60_000);
    seedPosted(signals, 'search', 7, 60_000);

    const usage = await budget.usage(NOW);
    expect(usage.total).toBe(11);
    expect(usage.byAdapter).toEqual({ manual: 4, search: 7 });
  });

  it('excludes a row posted at exactly now-24h, and includes one a millisecond later', async () => {
    const { signals, budget } = setup();

    signals.seed({
      id: 'exactly_on_the_boundary',
      adapterKey: 'manual',
      status: SignalStatus.POSTED,
      postedAt: new Date(NOW.getTime() - BUDGET_WINDOW_MS),
    });
    signals.seed({
      id: 'just_inside',
      adapterKey: 'manual',
      status: SignalStatus.POSTED,
      postedAt: new Date(NOW.getTime() - BUDGET_WINDOW_MS + 1),
    });
    signals.seed({
      id: 'well_outside',
      adapterKey: 'manual',
      status: SignalStatus.POSTED,
      postedAt: new Date(NOW.getTime() - BUDGET_WINDOW_MS - 3_600_000),
    });

    const usage = await budget.usage(NOW);
    expect(usage.total).toBe(1);
    expect(usage.byAdapter['manual']).toBe(1);
  });

  it('lets a row age out of the window as time passes', async () => {
    const { signals, budget } = setup();
    seedPosted(signals, 'manual', 1, BUDGET_WINDOW_MS - 1000);

    expect((await budget.usage(NOW)).total).toBe(1);
    expect((await budget.usage(new Date(NOW.getTime() + 2000))).total).toBe(0);
  });
});

describe('BudgetService — caps', () => {
  it('allows a post when both caps have room', async () => {
    const { signals, budget } = setup();
    seedPosted(signals, 'manual', 10, 60_000);

    const decision = await budget.check('manual', NOW);
    expect(decision.allowed).toBe(true);
  });

  it('blocks on the total cap even when the adapter has room', async () => {
    const { signals, budget } = setup({ total: 12, budgets: { manual: 50, search: 100 } });
    seedPosted(signals, 'search', 12, 60_000);

    const decision = await budget.check('manual', NOW);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('total_exhausted');
    expect(decision.used).toBe(12);
    expect(decision.limit).toBe(12);
  });

  it('blocks on the per-adapter cap even when the total has room', async () => {
    const { signals, budget } = setup({ total: 500, budgets: { manual: 5, search: 100 } });
    seedPosted(signals, 'manual', 5, 60_000);

    const decision = await budget.check('manual', NOW);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('adapter_exhausted');
    expect(decision.limit).toBe(5);
  });

  it('does not let one noisy adapter starve another', async () => {
    const { signals, budget } = setup({ total: 500, budgets: { manual: 50, search: 100 } });
    seedPosted(signals, 'search', 100, 60_000);

    expect((await budget.check('search', NOW)).allowed).toBe(false);
    expect((await budget.check('manual', NOW)).allowed).toBe(true);
  });

  it('allows the very last post under the cap, then blocks', async () => {
    const { signals, budget } = setup({ total: 500, budgets: { manual: 3 } });
    seedPosted(signals, 'manual', 2, 60_000);
    expect((await budget.check('manual', NOW)).allowed).toBe(true);

    seedPosted(signals, 'manual', 1, 30_000);
    expect((await budget.check('manual', NOW)).allowed).toBe(false);
  });

  it('fails closed for an adapter with no configured budget', async () => {
    const { budget } = setup({ budgets: { manual: 50 } });

    const decision = await budget.check('calendar', NOW);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('adapter_exhausted');
    expect(decision.limit).toBe(0);
  });

  it('admits at most the cap across any 24h span, unlike a calendar-day counter', async () => {
    // The OQ-3 safety argument, as a test: post the full cap just before a
    // midnight boundary, then ask again just after it. A calendar-day counter
    // would have reset and allowed a second full cap.
    const { signals, budget } = setup({ total: 500, budgets: { manual: 5 } });
    const justBeforeMidnight = new Date('2026-09-20T23:59:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      signals.seed({
        id: `late_${i}`,
        adapterKey: 'manual',
        status: SignalStatus.POSTED,
        postedAt: justBeforeMidnight,
      });
    }

    const justAfterMidnight = new Date('2026-09-21T00:01:00.000Z');
    expect((await budget.check('manual', justAfterMidnight)).allowed).toBe(false);

    // Only once the window itself has passed does capacity return.
    const afterWindow = new Date(justBeforeMidnight.getTime() + BUDGET_WINDOW_MS + 1000);
    expect((await budget.check('manual', afterWindow)).allowed).toBe(true);
  });
});
