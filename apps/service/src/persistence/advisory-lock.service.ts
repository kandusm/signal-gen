import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/** Long enough for a cron adapter's fetch; Prisma's interactive default is 5s. */
export const DEFAULT_LOCK_HOLD_MS = 10 * 60 * 1000;

/**
 * A Postgres advisory lock held for the duration of `work`, so two instances
 * (or an overlapping cron tick) cannot run the same adapter at once.
 * Built in Phase 1, first exercised by the Phase 2 cron adapters.
 *
 * ## Why the transaction-scoped variant
 *
 * The brief says `pg_advisory_lock`. The session-scoped form is unsafe here:
 * DATABASE_URL is Supabase's *transaction* pooler (pgbouncer), which may hand
 * the unlock to a different backend than the lock, leaving the lock held by a
 * session nobody controls. `pg_try_advisory_xact_lock` inside a transaction
 * has no unlock to misroute — the lock ends when the transaction does, on
 * success, error or crash.
 *
 * The transaction exists only to hold the lock; `work` runs its own queries
 * on other connections as usual.
 */
@Injectable()
export class AdvisoryLockService {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs `work` if the lock is free; returns `{ acquired: false }` if not. Never waits. */
  async tryWithLock<T>(
    key: string,
    work: () => Promise<T>,
    holdMs: number = DEFAULT_LOCK_HOLD_MS,
  ): Promise<LockResult<T>> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS "locked"`;
        if (!row?.locked) return { acquired: false } as const;
        return { acquired: true, value: await work() } as const;
      },
      { maxWait: 5_000, timeout: holdMs },
    );
  }
}

/** Lock key for one adapter's runs. Namespaced so other lock users cannot collide. */
export function adapterLockKey(adapterKey: string): string {
  return `signalgen:adapter:${adapterKey}`;
}
