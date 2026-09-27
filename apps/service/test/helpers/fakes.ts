import type { Signal } from '@prisma/client';
import type { Alert } from '../../src/notify';
import type { AdmitInput, AdmitResult, CreatePendingInput, RunCounts, TerminalUpdate, UsageCounts } from '../../src/persistence';
import { BUDGET_CONSUMING_STATUSES, SignalStatus, suppressionRecord } from '../../src/persistence';
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

  async createRejected(input: CreatePendingInput, update: TerminalUpdate): Promise<Signal> {
    if (this.rows.has(input.id)) throw new Error(`duplicate ledger id ${input.id}`);
    return this.seed({
      ...input,
      subtopic: input.subtopic ?? null,
      payload: input.payload as never,
      status: update.status,
      dmResponse: (update.dmResponse ?? null) as Signal['dmResponse'],
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
      if (!BUDGET_CONSUMING_STATUSES.includes(row.status as SignalStatus)) continue;
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
      suppressDays?: Record<string, number>;
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

  suppressionWindowMs(adapterKey: string): number | undefined {
    const days = (this.values.suppressDays ?? { manual: 7, search: 21 })[adapterKey];
    return days === undefined ? undefined : days * 24 * 60 * 60 * 1000;
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

/**
 * In-memory FingerprintRepository.admit with the production window semantics:
 * a hash whose suppressUntil is still in the future suppresses; a lapsed one
 * (including exactly-now) is reclaimed. JavaScript's single thread makes this
 * atomic for free, so it proves the pipeline's use of admit, not the SQL — the
 * race itself is proven against Postgres in test/db/.
 */
export class FakeFingerprintRepository {
  readonly hashes = new Map<
    string,
    { adapterKey: string; firstSeenAt: Date; lastSeenAt: Date; lastPostedSignalId: string | null; suppressUntil: Date | null }
  >();

  constructor(private readonly signals: FakeSignalRepository) {}

  async admit(input: AdmitInput): Promise<AdmitResult> {
    const { signal, now, windowMs } = input;
    const existing = this.hashes.get(signal.fingerprint);
    const live = existing?.suppressUntil && existing.suppressUntil.getTime() > now.getTime();

    if (existing && live) {
      existing.lastSeenAt = now;
      const row = await this.signals.createRejected(signal, {
        status: SignalStatus.SUPPRESSED,
        dmResponse: suppressionRecord(existing),
      });
      return { outcome: 'suppressed', signal: row };
    }

    this.hashes.set(signal.fingerprint, {
      adapterKey: signal.adapterKey,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastPostedSignalId: signal.id,
      suppressUntil: new Date(now.getTime() + windowMs),
    });
    return { outcome: 'admitted', signal: await this.signals.createPending(signal) };
  }
}

/** In-memory AdapterRunRepository. */
export class FakeAdapterRunRepository {
  readonly runs: Array<{
    id: number;
    adapterKey: string;
    startedAt: Date;
    finishedAt: Date | null;
    status: string;
    itemsFetched: number;
    candidatesEmitted: number;
    error: string | null;
  }> = [];

  async start(adapterKey: string, startedAt: Date) {
    const run = {
      id: this.runs.length + 1,
      adapterKey,
      startedAt,
      finishedAt: null,
      status: 'running',
      itemsFetched: 0,
      candidatesEmitted: 0,
      error: null,
    };
    this.runs.push(run);
    return run;
  }

  async finishOk(id: number, finishedAt: Date, counts: RunCounts) {
    return Object.assign(this.require(id), { status: 'ok', finishedAt, ...counts });
  }

  async finishFailed(id: number, finishedAt: Date, error: string) {
    return Object.assign(this.require(id), { status: 'failed', finishedAt, error });
  }

  private require(id: number) {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`no run ${id}`);
    return run;
  }
}
