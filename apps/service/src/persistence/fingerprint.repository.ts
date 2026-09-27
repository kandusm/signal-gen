import { Injectable } from '@nestjs/common';
import type { Prisma, Signal } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { type CreatePendingInput, jsonOrNull, ledgerFields } from './signal.repository';
import { SignalStatus } from './signal-status';

export interface AdmitInput {
  signal: CreatePendingInput;
  now: Date;
  /** How long a claimed fingerprint suppresses repeats (spec §8). */
  windowMs: number;
}

export type AdmitResult =
  | { outcome: 'admitted'; signal: Signal }
  | { outcome: 'suppressed'; signal: Signal };

interface FingerprintState {
  firstSeenAt: Date;
  suppressUntil: Date | null;
  lastPostedSignalId: string | null;
}

/**
 * The dedup decision and its ledger row, as one atomic step.
 *
 * Deliberately not check-then-write. Two identical candidates racing must
 * produce exactly one `pending` and one `suppressed` (Phase 1 brief §3), and a
 * read followed by a write lets both readers see "no live fingerprint".
 *
 * Instead the claim is a single statement:
 *
 *   INSERT … ON CONFLICT (hash) DO UPDATE … WHERE suppressUntil <= now
 *
 * A new hash inserts. An existing hash updates only if its window has lapsed.
 * Postgres serialises concurrent writers on the row and re-evaluates the WHERE
 * against the winner's committed version, so the loser always sees a live
 * window and gets no row back. "No row returned" is therefore exactly
 * "suppressed", with no gap between deciding and recording.
 *
 * The claim and the Signal insert share a transaction: a crash between them
 * cannot leave a fingerprint suppressing repeats of a signal that was never
 * ledgered.
 */
@Injectable()
export class FingerprintRepository {
  constructor(private readonly prisma: PrismaService) {}

  admit(input: AdmitInput): Promise<AdmitResult> {
    const { signal, now } = input;
    const suppressUntil = new Date(now.getTime() + input.windowMs);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ hash: string }[]>`
        INSERT INTO "Fingerprint"
          ("hash", "adapterKey", "firstSeenAt", "lastSeenAt", "lastPostedSignalId", "suppressUntil")
        VALUES (${signal.fingerprint}, ${signal.adapterKey}, ${now}, ${now}, ${signal.id}, ${suppressUntil})
        ON CONFLICT ("hash") DO UPDATE SET
          "lastSeenAt" = EXCLUDED."lastSeenAt",
          "lastPostedSignalId" = EXCLUDED."lastPostedSignalId",
          "suppressUntil" = EXCLUDED."suppressUntil"
        WHERE "Fingerprint"."suppressUntil" IS NULL
           OR "Fingerprint"."suppressUntil" <= EXCLUDED."lastSeenAt"
        RETURNING "hash"`;

      if (claimed.length === 1) {
        const row = await tx.signal.create({
          data: { ...ledgerFields(signal), status: SignalStatus.PENDING },
        });
        return { outcome: 'admitted', signal: row };
      }

      // A live window covers this hash. Record the sighting, and keep enough on
      // the suppressed row to audit what dedup is eating without a join.
      const [state] = await tx.$queryRaw<FingerprintState[]>`
        UPDATE "Fingerprint" SET "lastSeenAt" = ${now}
        WHERE "hash" = ${signal.fingerprint}
        RETURNING "firstSeenAt", "suppressUntil", "lastPostedSignalId"`;

      const row = await tx.signal.create({
        data: {
          ...ledgerFields(signal),
          status: SignalStatus.SUPPRESSED,
          dmResponse: jsonOrNull(suppressionRecord(state)),
        },
      });
      return { outcome: 'suppressed', signal: row };
    });
  }
}

/** The suppressed row's `dmResponse`: which earlier signal covers it, and until when. */
export function suppressionRecord(state: FingerprintState | undefined): Prisma.InputJsonValue {
  return {
    dedup: 'SUPPRESSED',
    suppressUntil: state?.suppressUntil?.toISOString() ?? null,
    firstSeenAt: state?.firstSeenAt.toISOString() ?? null,
    coveredBySignalId: state?.lastPostedSignalId ?? null,
  };
}
