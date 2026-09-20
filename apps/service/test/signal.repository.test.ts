import { describe, expect, it, vi } from 'vitest';
import { SignalRepository, SignalStatus } from '../src/persistence';

/**
 * These tests assert the *queries*, not a fake.
 *
 * The trailing-window boundary that budget.test.ts exercises lives in a Prisma
 * `where` clause, so testing it through an in-memory fake would only prove the
 * fake agrees with itself. Here the Prisma client is a spy and the assertion is
 * on the query object actually handed to it — in particular `gt` rather than
 * `gte`, which is the difference between a 24h window that admits 500 posts and
 * one that admits 501.
 */
function setup() {
  const groupBy = vi.fn().mockResolvedValue([]);
  const findMany = vi.fn().mockResolvedValue([]);
  const create = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn().mockResolvedValue(null);

  const prisma = { signal: { groupBy, findMany, create, update, findUnique } };
  const repo = new SignalRepository(prisma as never);
  return { repo, groupBy, findMany, create, update, findUnique };
}

describe('SignalRepository.usageSince', () => {
  it('uses a half-open window: gt, not gte', async () => {
    const { repo, groupBy } = setup();
    const since = new Date('2026-09-19T12:00:00.000Z');

    await repo.usageSince(since);

    const args = groupBy.mock.calls[0]?.[0];
    expect(args.where.postedAt).toEqual({ gt: since });
    expect(args.where.postedAt).not.toHaveProperty('gte');
  });

  it('counts only rows that actually consumed DM quota', async () => {
    const { repo, groupBy } = setup();

    await repo.usageSince(new Date());

    const args = groupBy.mock.calls[0]?.[0];
    expect(args.where.status).toEqual({ in: [SignalStatus.POSTED] });
    expect(args.by).toEqual(['adapterKey']);
  });

  it('sums the per-adapter counts into a total', async () => {
    const { repo, groupBy } = setup();
    groupBy.mockResolvedValue([
      { adapterKey: 'manual', _count: { _all: 4 } },
      { adapterKey: 'reddit', _count: { _all: 7 } },
    ]);

    const usage = await repo.usageSince(new Date());

    expect(usage).toEqual({ total: 11, byAdapter: { manual: 4, reddit: 7 } });
  });
});

describe('SignalRepository.findDispatchable', () => {
  it('asks for pending rows that are parked or due, oldest first', async () => {
    const { repo, findMany } = setup();
    const now = new Date('2026-09-20T12:00:00.000Z');

    await repo.findDispatchable(now, 25);

    const args = findMany.mock.calls[0]?.[0];
    expect(args.where.status).toBe(SignalStatus.PENDING);
    expect(args.where.OR).toEqual([{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]);
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.take).toBe(25);
  });

  it('uses lte, so a row scheduled for exactly now is due', async () => {
    const { repo, findMany } = setup();
    const now = new Date();

    await repo.findDispatchable(now, 10);

    const or = findMany.mock.calls[0]?.[0].where.OR;
    expect(or[1].nextAttemptAt).toEqual({ lte: now });
  });
});

describe('SignalRepository writes', () => {
  it('creates rows in the pending state', async () => {
    const { repo, create } = setup();

    await repo.createPending({
      id: 'man_1',
      fingerprint: 'fp',
      adapterKey: 'manual',
      sourceKey: 'signalgen-v1',
      topic: 'Trades',
      tone: 'Professional',
      platform: 'LinkedIn',
      payload: { signalId: 'man_1' },
    });

    const data = create.mock.calls[0]?.[0].data;
    expect(data.status).toBe(SignalStatus.PENDING);
    expect(data.subtopic).toBeNull();
    expect(data).not.toHaveProperty('postedAt');
  });

  it('clears nextAttemptAt when finalizing, so a terminal row is never re-swept', async () => {
    const { repo, update } = setup();

    await repo.finalize('man_1', { status: SignalStatus.FAILED_PERMANENT, dmStatusCode: 400 });

    const data = update.mock.calls[0]?.[0].data;
    expect(data.status).toBe(SignalStatus.FAILED_PERMANENT);
    expect(data.nextAttemptAt).toBeNull();
  });

  it('returns a row to pending when booking a retry', async () => {
    const { repo, update } = setup();
    const at = new Date('2026-09-20T12:01:00.000Z');

    await repo.scheduleRetry('man_1', at, { dmStatusCode: 503, dmResponse: 'unavailable' });

    const data = update.mock.calls[0]?.[0].data;
    expect(data.status).toBe(SignalStatus.PENDING);
    expect(data.nextAttemptAt).toBe(at);
    expect(data.dmStatusCode).toBe(503);
  });

  it('increments attempts atomically rather than read-modify-write', async () => {
    const { repo, update } = setup();

    await repo.incrementAttempts('man_1');

    expect(update.mock.calls[0]?.[0].data).toEqual({ attempts: { increment: 1 } });
  });
});
