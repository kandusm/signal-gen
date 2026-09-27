import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/common';
import { SWEEP_BATCH_SIZE, SweepService } from '../src/dm';
import { SignalStatus } from '../src/persistence';
import { FakeSignalRepository } from './helpers/fakes';

const NOW = new Date('2026-09-20T12:00:00.000Z');

/**
 * Stands in for DmClient. Records dispatch order and returns whatever the
 * scripted outcome for that row is, defaulting to a successful post.
 */
class FakeDmClient {
  readonly dispatched: string[] = [];

  constructor(
    private readonly signals: FakeSignalRepository,
    private readonly outcomes: Map<string, { status: string; parkedReason?: string }> = new Map(),
  ) {}

  async dispatch(signal: { id: string; adapterKey: string }) {
    this.dispatched.push(signal.id);
    const outcome = this.outcomes.get(signal.id) ?? { status: SignalStatus.POSTED };

    if (outcome.status === SignalStatus.POSTED) {
      await this.signals.finalize(signal.id, {
        status: SignalStatus.POSTED,
        dmStatusCode: 202,
        postedAt: NOW,
      });
    }
    return { signalId: signal.id, ...outcome };
  }
}

function setup(options: { outcomes?: Map<string, { status: string; parkedReason?: string }> } = {}) {
  const clock = fixedClock(NOW);
  const signals = new FakeSignalRepository(clock);
  const dm = new FakeDmClient(signals, options.outcomes);
  const sweep = new SweepService(signals as never, dm as never, clock);
  return { clock, signals, dm, sweep };
}

/** Seeds a pending row created `agoMs` before NOW. */
function seedPending(
  signals: FakeSignalRepository,
  id: string,
  agoMs: number,
  nextAttemptAt: Date | null = null,
): void {
  signals.seed({
    id,
    status: SignalStatus.PENDING,
    createdAt: new Date(NOW.getTime() - agoMs),
    nextAttemptAt,
  });
}

describe('SweepService — drain order', () => {
  it('drains pending rows oldest first', async () => {
    const { signals, dm, sweep } = setup();
    seedPending(signals, 'newest', 1_000);
    seedPending(signals, 'oldest', 90_000);
    seedPending(signals, 'middle', 30_000);

    const summary = await sweep.sweep();

    expect(dm.dispatched).toEqual(['oldest', 'middle', 'newest']);
    expect(summary).toEqual({ examined: 3, posted: 3, dryRun: 0, parked: 0, failed: 0 });
  });

  it('orders a retry-due row and a budget-parked row together by age', async () => {
    const { signals, dm, sweep } = setup();
    // A retry booked in the past is due now; both kinds of row compete on age
    // alone, so neither can starve the other.
    seedPending(signals, 'retry_old', 120_000, new Date(NOW.getTime() - 1_000));
    seedPending(signals, 'parked_new', 5_000, null);
    seedPending(signals, 'parked_older', 60_000, null);

    await sweep.sweep();

    expect(dm.dispatched).toEqual(['retry_old', 'parked_older', 'parked_new']);
  });

  it('skips a row whose retry is still in the future', async () => {
    const { signals, dm, sweep } = setup();
    seedPending(signals, 'not_yet', 120_000, new Date(NOW.getTime() + 60_000));
    seedPending(signals, 'ready', 10_000);

    await sweep.sweep();

    expect(dm.dispatched).toEqual(['ready']);
  });

  it('picks up a row exactly at its scheduled time', async () => {
    const { signals, dm, sweep } = setup();
    seedPending(signals, 'due_now', 120_000, NOW);

    await sweep.sweep();

    expect(dm.dispatched).toEqual(['due_now']);
  });

  it('ignores rows that are not pending', async () => {
    const { signals, dm, sweep } = setup();
    for (const status of [
      SignalStatus.POSTED,
      SignalStatus.DRY_RUN,
      SignalStatus.FAILED,
      SignalStatus.FAILED_PERMANENT,
      SignalStatus.REJECTED_SCHEMA,
      SignalStatus.REJECTED_TONE,
      SignalStatus.SUPPRESSED,
    ]) {
      signals.seed({ id: `row_${status}`, status, createdAt: new Date(NOW.getTime() - 60_000) });
    }
    seedPending(signals, 'the_only_pending_one', 1_000);

    await sweep.sweep();

    expect(dm.dispatched).toEqual(['the_only_pending_one']);
  });

  it('takes at most one batch per tick', async () => {
    const { signals, dm, sweep } = setup();
    for (let i = 0; i < SWEEP_BATCH_SIZE + 10; i += 1) {
      seedPending(signals, `row_${String(i).padStart(3, '0')}`, 100_000 - i);
    }

    await sweep.sweep();

    expect(dm.dispatched).toHaveLength(SWEEP_BATCH_SIZE);
  });
});

describe('SweepService — budget and rate interaction', () => {
  it('stops the pass when the local rate limit is exhausted', async () => {
    const outcomes = new Map([
      ['second', { status: SignalStatus.PENDING, parkedReason: 'rate_limited_local' }],
    ]);
    const { signals, dm, sweep } = setup({ outcomes });
    seedPending(signals, 'first', 30_000);
    seedPending(signals, 'second', 20_000);
    seedPending(signals, 'third', 10_000);

    const summary = await sweep.sweep();

    // The bucket is empty for every remaining row too; re-checking it N more
    // times would achieve nothing.
    expect(dm.dispatched).toEqual(['first', 'second']);
    expect(summary.parked).toBe(1);
  });

  it('keeps going past a budget-blocked row, since another adapter may have room', async () => {
    const outcomes = new Map([
      ['search_row', { status: SignalStatus.PENDING, parkedReason: 'budget_exhausted' }],
    ]);
    const { signals, dm, sweep } = setup({ outcomes });
    signals.seed({
      id: 'search_row',
      adapterKey: 'search',
      status: SignalStatus.PENDING,
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    seedPending(signals, 'manual_row', 30_000);

    const summary = await sweep.sweep();

    expect(dm.dispatched).toEqual(['search_row', 'manual_row']);
    expect(summary).toEqual({ examined: 2, posted: 1, dryRun: 0, parked: 1, failed: 0 });
  });

  it('counts terminal failures separately', async () => {
    const outcomes = new Map([['doomed', { status: SignalStatus.FAILED_PERMANENT }]]);
    const { signals, dm, sweep } = setup({ outcomes });
    seedPending(signals, 'doomed', 30_000);
    seedPending(signals, 'fine', 10_000);

    const summary = await sweep.sweep();

    expect(dm.dispatched).toEqual(['doomed', 'fine']);
    expect(summary).toEqual({ examined: 2, posted: 1, dryRun: 0, parked: 0, failed: 1 });
  });
});

describe('SweepService — cron behaviour', () => {
  it('drains in DRY_RUN too, counting dry_run outcomes separately', async () => {
    // Phase 1 brief §1: a dry run can be parked by a guard like a real post,
    // so the sweep must come back for it. DmClient.dispatch is what skips the
    // network; the sweep does not need to know.
    const outcomes = new Map([['rehearsal', { status: SignalStatus.DRY_RUN }]]);
    const { signals, dm, sweep } = setup({ outcomes });
    seedPending(signals, 'rehearsal', 10_000);

    const summary = await sweep.sweep();

    expect(dm.dispatched).toEqual(['rehearsal']);
    expect(summary).toEqual({ examined: 1, posted: 0, dryRun: 1, parked: 0, failed: 0 });
  });

  it('skips a tick while the previous pass is still running', async () => {
    const { signals, sweep } = setup();
    seedPending(signals, 'row', 10_000);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = sweep.sweep.bind(sweep);
    let passes = 0;
    sweep.sweep = async () => {
      passes += 1;
      await gate;
      return original();
    };

    const first = sweep.handleCron();
    const second = sweep.handleCron();
    release?.();
    await Promise.all([first, second]);

    // The second tick found the guard set and returned without a pass.
    expect(passes).toBe(1);
  });

  it('swallows a failing pass so the cron keeps running', async () => {
    const { sweep } = setup();
    sweep.sweep = async () => {
      throw new Error('database gone');
    };

    await expect(sweep.handleCron()).resolves.toBeUndefined();
  });
});
