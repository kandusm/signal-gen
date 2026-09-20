import type { Signal } from '@prisma/client';
import type { Alert } from '../../src/notify';
import type { CreatePendingInput, TerminalUpdate, UsageCounts } from '../../src/persistence';
import { SignalStatus } from '../../src/persistence';
import type { DmHttpResult } from '../../src/dm';

/**
 * In-memory stand-in for SignalRepository.
 *
 * Mirrors the production query semantics that the tests depend on, in
 * particular the half-open trailing window (`postedAt > since`). The Prisma
 * query that implements that for real is asserted separately in
 * signal.repository.test.ts, so the two cannot drift silently.
 */
export class FakeSignalRepository {
  readonly rows = new Map<string, Signal>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Seeds a row directly, bypassing the pipeline. */
  seed(partial: Partial<Signal> & { id: string }): Signal {
    const row: Signal = {
      id: partial.id,
      fingerprint: partial.fingerprint ?? 'fp',
      adapterKey: partial.adapterKey ?? 'manual',
      sourceKey: partial.sourceKey ?? 'signalgen-v1',
      topic: partial.topic ?? 'Trades',
      subtopic: partial.subtopic ?? null,
      tone: partial.tone ?? 'Professional',
      platform: partial.platform ?? 'LinkedIn',
      payload: partial.payload ?? ({ signalId: partial.id } as never),
      status: partial.status ?? SignalStatus.PENDING,
      attempts: partial.attempts ?? 0,
      dmStatusCode: partial.dmStatusCode ?? null,
      dmResponse: partial.dmResponse ?? null,
      nextAttemptAt: partial.nextAttemptAt ?? null,
      createdAt: partial.createdAt ?? this.now(),
      postedAt: partial.postedAt ?? null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async createPending(input: CreatePendingInput): Promise<Signal> {
    if (this.rows.has(input.id)) throw new Error(`duplicate ledger id ${input.id}`);
    return this.seed({
      ...input,
      subtopic: input.subtopic ?? null,
      payload: input.payload as never,
      status: SignalStatus.PENDING,
      createdAt: this.now(),
    });
  }

  async findById(id: string): Promise<Signal | null> {
    return this.rows.get(id) ?? null;
  }

  async finalize(id: string, update: TerminalUpdate): Promise<Signal> {
    const row = this.require(id);
    const next: Signal = {
      ...row,
      status: update.status,
      dmStatusCode: update.dmStatusCode ?? null,
      dmResponse: (update.dmResponse ?? null) as Signal['dmResponse'],
      postedAt: update.postedAt ?? null,
      nextAttemptAt: null,
    };
    this.rows.set(id, next);
    return next;
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: Date,
    outcome: { dmStatusCode?: number | undefined; dmResponse?: unknown },
  ): Promise<Signal> {
    const row = this.require(id);
    const next: Signal = {
      ...row,
      status: SignalStatus.PENDING,
      nextAttemptAt,
      dmStatusCode: outcome.dmStatusCode ?? null,
      dmResponse: (outcome.dmResponse ?? null) as Signal['dmResponse'],
    };
    this.rows.set(id, next);
    return next;
  }

  async incrementAttempts(id: string): Promise<Signal> {
    const row = this.require(id);
    const next: Signal = { ...row, attempts: row.attempts + 1 };
    this.rows.set(id, next);
    return next;
  }

  /** Half-open window, matching the production `postedAt: { gt: since }`. */
  async usageSince(since: Date): Promise<UsageCounts> {
    const byAdapter: Record<string, number> = {};
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.status !== SignalStatus.POSTED) continue;
      if (!row.postedAt || row.postedAt.getTime() <= since.getTime()) continue;
      byAdapter[row.adapterKey] = (byAdapter[row.adapterKey] ?? 0) + 1;
      total += 1;
    }
    return { total, byAdapter };
  }

  async findDispatchable(now: Date, limit: number): Promise<Signal[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === SignalStatus.PENDING)
      .filter((row) => row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  private require(id: string): Signal {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no ledger row ${id}`);
    return row;
  }
}

/** Serves scripted DM responses, and records what it was asked to send. */
export class FakeDmHttpClient {
  readonly posts: Array<{ payload: unknown; signalId: string }> = [];
  readonly taxonomyCalls: number[] = [];

  constructor(
    private readonly postResults: DmHttpResult[] = [],
    private taxonomyResults: DmHttpResult[] = [],
  ) {}

  async postSignal(payload: unknown, signalId: string): Promise<DmHttpResult> {
    this.posts.push({ payload, signalId });
    const next = this.postResults.shift();
    if (!next) throw new Error('FakeDmHttpClient ran out of scripted POST results');
    return next;
  }

  async getTaxonomy(): Promise<DmHttpResult> {
    this.taxonomyCalls.push(Date.now());
    const next = this.taxonomyResults.shift();
    if (!next) throw new Error('FakeDmHttpClient ran out of scripted taxonomy results');
    return next;
  }

  queueTaxonomy(...results: DmHttpResult[]): void {
    this.taxonomyResults = [...this.taxonomyResults, ...results];
  }
}

/** Captures alerts instead of sending them. */
export class FakeNotifyService {
  readonly sent: Alert[] = [];
  readonly throttledKeys: string[] = [];
  private readonly seenKeys = new Set<string>();

  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }

  async sendThrottled(key: string, alert: Alert): Promise<void> {
    this.throttledKeys.push(key);
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    this.sent.push(alert);
  }

  kinds(): string[] {
    return this.sent.map((alert) => alert.kind);
  }
}

/** In-memory TaxonomySnapshotRepository. */
export class FakeTaxonomySnapshotRepository {
  readonly snapshots: Array<{ body: unknown; fetchedAt: Date }> = [];
  /** Set to make reads fail, for the "no snapshot available" path. */
  failReads = false;

  async create(body: unknown, fetchedAt: Date): Promise<{ id: number; body: unknown; fetchedAt: Date }> {
    this.snapshots.push({ body, fetchedAt });
    return { id: this.snapshots.length, body, fetchedAt };
  }

  async findLatest(): Promise<{ id: number; body: unknown; fetchedAt: Date } | null> {
    if (this.failReads) throw new Error('snapshot read failed');
    const latest = [...this.snapshots].sort(
      (a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime(),
    )[0];
    return latest ? { id: 1, ...latest } : null;
  }
}

/** Minimal ConfigService stand-in. */
export class FakeConfigService {
  constructor(
    private readonly values: {
      dryRun?: boolean;
      generatorSourceKey?: string;
      totalBudget24h?: number;
      budgets?: Record<string, number>;
      shortcodes?: Record<string, string>;
    } = {},
  ) {}

  get dryRun(): boolean {
    return this.values.dryRun ?? false;
  }

  get generatorSourceKey(): string {
    return this.values.generatorSourceKey ?? 'signalgen-v1';
  }

  get totalBudget24h(): number {
    return this.values.totalBudget24h ?? 500;
  }

  budgetFor(adapterKey: string): number {
    return this.values.budgets?.[adapterKey] ?? 0;
  }

  get budgetedAdapterKeys(): string[] {
    return Object.keys(this.values.budgets ?? { manual: 50, search: 100 });
  }

  shortcodeFor(adapterKey: string): string | undefined {
    return (this.values.shortcodes ?? { manual: 'man', search: 'srch' })[adapterKey];
  }
}

/** Builds a DM HTTP response result. */
export function httpResponse(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
): DmHttpResult {
  return {
    kind: 'response',
    status,
    retryAfter,
    body,
    rawBody: body === null ? '' : JSON.stringify(body),
  };
}

export function transportError(message: string): DmHttpResult {
  return { kind: 'transport_error', message };
}
