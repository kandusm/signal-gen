import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AdapterRunRepository,
  AdvisoryLockService,
  type CreatePendingInput,
  FingerprintRepository,
  SignalStatus,
  adapterLockKey,
} from '../../src/persistence';

/**
 * Postgres-backed proofs for what an in-memory fake cannot show: that the
 * dedup claim is atomic under real concurrency, that the claim and its ledger
 * row commit together, and that the advisory lock excludes.
 *
 * Runs only when TEST_DATABASE_URL is set — `pnpm --filter
 * @signalgen/service test:db` sets it against a local throwaway database. The
 * plain `pnpm test` stays offline and skips this file.
 */
const url = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-09-27T12:00:00.000Z');
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

describe.skipIf(!url)('Postgres: dedup, runs and locks', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const fingerprints = new FingerprintRepository(prisma as never);
  const locks = new AdvisoryLockService(prisma as never);
  const runs = new AdapterRunRepository(prisma as never);

  let seq = 0;
  function signal(fingerprint: string): CreatePendingInput {
    seq += 1;
    return {
      id: `man_test_${seq}_${Math.random().toString(36).slice(2, 8)}`,
      fingerprint,
      adapterKey: 'manual',
      sourceKey: 'signalgen-v1',
      topic: 'Trades',
      subtopic: 'Welding',
      tone: 'Professional',
      platform: 'LinkedIn',
      payload: { test: true },
    };
  }

  const admit = (fp: string, now = NOW) => fingerprints.admit({ signal: signal(fp), now, windowMs: WINDOW_MS });

  async function statusCounts(fp: string) {
    const rows = await prisma.signal.findMany({ where: { fingerprint: fp }, select: { status: true } });
    return {
      pending: rows.filter((r) => r.status === SignalStatus.PENDING).length,
      suppressed: rows.filter((r) => r.status === SignalStatus.SUPPRESSED).length,
    };
  }

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "Signal", "Fingerprint", "AdapterRun" RESTART IDENTITY`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the race', () => {
    it('two identical candidates in parallel → exactly one pending, one suppressed', async () => {
      // Repeated, because a single lucky interleaving proves little.
      for (let round = 0; round < 25; round += 1) {
        const fp = `race-pair-${round}`;
        const results = await Promise.all([admit(fp), admit(fp)]);

        expect(results.map((r) => r.outcome).sort()).toEqual(['admitted', 'suppressed']);
        expect(await statusCounts(fp)).toEqual({ pending: 1, suppressed: 1 });
      }
    });

    it('eight in parallel → still exactly one pending', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => admit('race-eight')));

      expect(results.filter((r) => r.outcome === 'admitted')).toHaveLength(1);
      expect(await statusCounts('race-eight')).toEqual({ pending: 1, suppressed: 7 });
    });

    it('racing to reclaim an expired fingerprint → exactly one wins', async () => {
      await admit('race-expired', new Date(NOW.getTime() - WINDOW_MS - 1));

      const results = await Promise.all(Array.from({ length: 6 }, () => admit('race-expired')));

      expect(results.filter((r) => r.outcome === 'admitted')).toHaveLength(1);
      // One pending from the original claim, one from the winning reclaim.
      expect(await statusCounts('race-expired')).toEqual({ pending: 2, suppressed: 5 });
    });
  });

  describe('window semantics in SQL', () => {
    it('suppresses 1 ms before suppressUntil and reclaims exactly at it', async () => {
      const first = await admit('window');
      expect(first.outcome).toBe('admitted');

      expect((await admit('window', new Date(NOW.getTime() + WINDOW_MS - 1))).outcome).toBe('suppressed');
      expect((await admit('window', new Date(NOW.getTime() + WINDOW_MS))).outcome).toBe('admitted');
    });

    it('records the covering signal and updates lastSeenAt on suppression', async () => {
      const first = await admit('audit');
      const later = new Date(NOW.getTime() + 60_000);
      const second = await admit('audit', later);

      expect(second.signal.dmResponse).toEqual({
        dedup: 'SUPPRESSED',
        suppressUntil: new Date(NOW.getTime() + WINDOW_MS).toISOString(),
        firstSeenAt: NOW.toISOString(),
        coveredBySignalId: first.signal.id,
      });
      const fp = await prisma.fingerprint.findUniqueOrThrow({ where: { hash: 'audit' } });
      expect(fp.lastSeenAt).toEqual(later);
      expect(fp.firstSeenAt).toEqual(NOW);
    });

    it('rolls the claim back if the ledger row cannot be written', async () => {
      const taken = await admit('first-hash');
      // Same signal id as an existing row: the Signal insert fails inside the
      // transaction, so the fresh claim on "orphan" must not survive.
      await expect(
        fingerprints.admit({ signal: { ...signal('orphan'), id: taken.signal.id }, now: NOW, windowMs: WINDOW_MS }),
      ).rejects.toThrow();

      expect(await prisma.fingerprint.findUnique({ where: { hash: 'orphan' } })).toBeNull();
    });
  });

  describe('advisory lock', () => {
    it('lets exactly one holder in per key, and releases when work ends', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });

      const holder = locks.tryWithLock(adapterLockKey('search'), async () => {
        entered();
        await held;
        return 'first';
      });
      await inside;

      expect(await locks.tryWithLock(adapterLockKey('search'), async () => 'second')).toEqual({
        acquired: false,
      });
      // A different adapter is unaffected.
      expect(await locks.tryWithLock(adapterLockKey('manual'), async () => 'other')).toEqual({
        acquired: true,
        value: 'other',
      });

      release();
      expect(await holder).toEqual({ acquired: true, value: 'first' });
      expect(await locks.tryWithLock(adapterLockKey('search'), async () => 'third')).toEqual({
        acquired: true,
        value: 'third',
      });
    });

    it('releases the lock when work throws', async () => {
      await expect(
        locks.tryWithLock(adapterLockKey('search'), async () => {
          throw new Error('adapter blew up');
        }),
      ).rejects.toThrow('adapter blew up');

      expect((await locks.tryWithLock(adapterLockKey('search'), async () => 1)).acquired).toBe(true);
    });
  });

  describe('adapter runs', () => {
    it('writes running, then ok with counts', async () => {
      const run = await runs.start('manual', NOW);
      expect(run.status).toBe('running');

      const done = await runs.finishOk(run.id, new Date(NOW.getTime() + 5), { itemsFetched: 1, candidatesEmitted: 1 });
      expect(done).toMatchObject({ status: 'ok', itemsFetched: 1, candidatesEmitted: 1 });
    });
  });
});
