import { Injectable } from '@nestjs/common';
import { Prisma, type Signal } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { BUDGET_CONSUMING_STATUSES, SignalStatus } from './signal-status';

export interface CreatePendingInput {
  id: string;
  fingerprint: string;
  adapterKey: string;
  sourceKey: string;
  topic: string;
  subtopic?: string | undefined;
  tone: string;
  platform: string;
  /** The candidate as it will be sent, or as far as it got before rejection. */
  payload: Prisma.InputJsonValue;
}

export interface TerminalUpdate {
  status: SignalStatus;
  dmStatusCode?: number | undefined;
  dmResponse?: Prisma.InputJsonValue | undefined;
  postedAt?: Date | undefined;
}

/**
 * Prisma will not accept a bare `null` for a nullable Json column -- it cannot
 * tell "SQL NULL" from "the JSON value null". DbNull is the explicit former.
 */
export function jsonOrNull(value: Prisma.InputJsonValue | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined ? Prisma.DbNull : value;
}

/** The identifying columns every ledger row carries, whatever its status. */
export function ledgerFields(input: CreatePendingInput) {
  return {
    id: input.id,
    fingerprint: input.fingerprint,
    adapterKey: input.adapterKey,
    sourceKey: input.sourceKey,
    topic: input.topic,
    subtopic: input.subtopic ?? null,
    tone: input.tone,
    platform: input.platform,
    payload: input.payload,
  };
}

/** Trailing-window usage, total and broken out per adapter. */
export interface UsageCounts {
  total: number;
  byAdapter: Record<string, number>;
}

@Injectable()
export class SignalRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The ledger-before-post write. Called before any network attempt, so a
   * crash mid-dispatch leaves a recoverable `pending` row rather than a signal
   * that may or may not have reached DM.
   */
  createPending(input: CreatePendingInput): Promise<Signal> {
    return this.prisma.signal.create({ data: { ...ledgerFields(input), status: SignalStatus.PENDING } });
  }

  /**
   * A row that is terminal from birth: rejected before it could be dispatched.
   * Recorded so the ledger shows what the pipeline turned away and why.
   */
  createRejected(input: CreatePendingInput, update: TerminalUpdate): Promise<Signal> {
    return this.prisma.signal.create({
      data: {
        ...ledgerFields(input),
        status: update.status,
        dmResponse: jsonOrNull(update.dmResponse),
      },
    });
  }

  findById(id: string): Promise<Signal | null> {
    return this.prisma.signal.findUnique({ where: { id } });
  }

  /** Moves a row to a terminal state and clears any pending retry. */
  finalize(id: string, update: TerminalUpdate): Promise<Signal> {
    return this.prisma.signal.update({
      where: { id },
      data: {
        status: update.status,
        dmStatusCode: update.dmStatusCode ?? null,
        dmResponse: jsonOrNull(update.dmResponse),
        postedAt: update.postedAt ?? null,
        nextAttemptAt: null,
      },
    });
  }

  /** Records a failed attempt and parks the row until `nextAttemptAt`. */
  scheduleRetry(
    id: string,
    nextAttemptAt: Date,
    outcome: { dmStatusCode?: number | undefined; dmResponse?: Prisma.InputJsonValue | undefined },
  ): Promise<Signal> {
    return this.prisma.signal.update({
      where: { id },
      data: {
        status: SignalStatus.PENDING,
        nextAttemptAt,
        dmStatusCode: outcome.dmStatusCode ?? null,
        dmResponse: jsonOrNull(outcome.dmResponse),
      },
    });
  }

  incrementAttempts(id: string): Promise<Signal> {
    return this.prisma.signal.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  /**
   * Trailing-window usage.
   *
   * The window is half-open: `postedAt > since`. A row posted at exactly
   * `now - 24h` has aged out and does not count, which keeps the window from
   * ever admitting 501 posts across a 24h span.
   */
  async usageSince(since: Date): Promise<UsageCounts> {
    const rows = await this.prisma.signal.groupBy({
      by: ['adapterKey'],
      where: {
        status: { in: [...BUDGET_CONSUMING_STATUSES] },
        postedAt: { gt: since },
      },
      _count: { _all: true },
    });

    const byAdapter: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = row._count._all;
      byAdapter[row.adapterKey] = count;
      total += count;
    }
    return { total, byAdapter };
  }

  /**
   * Rows the sweep may dispatch, oldest first.
   *
   * Two kinds of row qualify, and they are deliberately the same query:
   *   - parked over budget   (nextAttemptAt is null)
   *   - waiting on a retry   (nextAttemptAt has passed)
   * Ordering by createdAt means the oldest signal drains first regardless of
   * which kind it is, so a retry storm cannot starve fresh candidates or
   * vice versa.
   */
  findDispatchable(now: Date, limit: number): Promise<Signal[]> {
    return this.prisma.signal.findMany({
      where: {
        status: SignalStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
