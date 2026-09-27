import type { CandidateSignal } from '@signalgen/contract';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry, type SourceAdapter } from '../src/adapters';
import { ManualAdapter } from '../src/adapters/manual';
import { fixedClock } from '../src/common';
import { BudgetService, DmClient, RateLimitService } from '../src/dm';
import { SignalStatus } from '../src/persistence';
import { type PolicyRule, PipelineService, PolicyScreen } from '../src/pipeline';
import {
  FakeConfigService,
  FakeDmHttpClient,
  FakeFingerprintRepository,
  FakeNotifyService,
  FakeSignalRepository,
  httpResponse,
} from './helpers/fakes';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPTED = () => httpResponse(202, { signalId: 'x', status: 'ACCEPTED', matchingScheduled: true });

/** Stands in for the Phase 2 search adapter, so prefixes and keys can differ. */
const searchAdapter: SourceAdapter = {
  key: 'search',
  schedule: '0 7 * * *',
  async fetch() {
    return [];
  },
  fingerprintMaterial: (c) => c.sourceUrl ?? '',
};

interface Options {
  dryRun?: boolean;
  /** undefined = every tone passes; null = no taxonomy; 'absent' = no tones key. */
  tones?: string[] | null | 'absent';
  rules?: PolicyRule[];
  manualBudget?: number;
  responses?: number;
  /** Replaces the HTTP fake, e.g. to observe the ledger at POST time. */
  http?: { postSignal(payload: unknown, signalId: string): Promise<unknown> };
}

function setup(options: Options = {}) {
  const clock = fixedClock(NOW);
  const config = new FakeConfigService({
    dryRun: options.dryRun ?? false,
    budgets: { manual: options.manualBudget ?? 50, search: 100 },
  });
  const signals = new FakeSignalRepository(clock);
  const fingerprints = new FakeFingerprintRepository(signals);
  const notify = new FakeNotifyService();
  const fakeHttp = new FakeDmHttpClient(Array.from({ length: options.responses ?? 5 }, ACCEPTED));
  const http = options.http ?? fakeHttp;

  const registry = new AdapterRegistry(config as never, null as never);
  registry.register(new ManualAdapter());
  registry.register(searchAdapter);

  const tones = options.tones;
  const taxonomy = {
    async isValidTone(tone: string) {
      if (tones === undefined) return true;
      if (tones === null) return 'no_taxonomy' as const;
      if (tones === 'absent') return 'no_tones' as const;
      return tones.includes(tone);
    },
    peek() {
      if (tones === undefined || tones === null) return null;
      const taxonomy = tones === 'absent' ? { categories: [] } : { categories: [], tones };
      return { taxonomy, fetchedAt: NOW, fromSnapshot: false };
    },
  };

  const dm = new DmClient(
    config as never,
    http as never,
    signals as never,
    new BudgetService(config as never, signals as never),
    new RateLimitService(clock),
    notify as never,
    clock,
  );
  const pipeline = new PipelineService(
    config as never,
    registry,
    new PolicyScreen(options.rules ?? []),
    taxonomy as never,
    signals as never,
    fingerprints as never,
    dm,
    notify as never,
    clock,
  );
  return { clock, signals, fingerprints, notify, http: fakeHttp, pipeline };
}

type Harness = ReturnType<typeof setup>;

function candidate(overrides: Record<string, unknown> = {}): CandidateSignal {
  return {
    adapterKey: 'manual',
    capturedAt: NOW.toISOString(),
    topic: 'Trades',
    subtopic: 'Welding',
    tone: 'Professional',
    platform: 'LinkedIn',
    taxonomyAligned: true,
    ...overrides,
  } as CandidateSignal;
}

function submit(h: Harness, c: CandidateSignal = candidate()) {
  return h.pipeline.process(c, { adapterKey: c.adapterKey ?? 'manual', startedAt: NOW, trigger: 'push' });
}

describe('PipelineService — ledger before network', () => {
  it('writes a pending row, with its final signalId, before the first POST', async () => {
    // Load-bearing (CLAUDE.md): a crash mid-dispatch must leave a recoverable
    // row, never an unknown. This must survive any refactor.
    const observed: Array<{ signalId: string; status: string | undefined }> = [];
    let h: Harness;
    const http = {
      async postSignal(_payload: unknown, signalId: string) {
        observed.push({ signalId, status: h.signals.rows.get(signalId)?.status });
        return ACCEPTED();
      },
    };
    h = setup({ http });

    const result = await submit(h);

    expect(observed).toEqual([{ signalId: result.signalId, status: SignalStatus.PENDING }]);
    expect(result.status).toBe(SignalStatus.POSTED);
  });

  it('prefixes the signalId with the adapter shortcode', async () => {
    const h = setup();
    expect((await submit(h)).signalId).toMatch(/^man_/);
    expect(
      (await submit(h, candidate({ adapterKey: 'search', platform: 'Web', sourceUrl: 'https://a.test/x' })))
        .signalId,
    ).toMatch(/^srch_/);
  });

  it('refuses a candidate for an adapter nobody registered', async () => {
    const h = setup();
    await expect(submit(h, candidate({ adapterKey: 'rss' }))).rejects.toThrow(/No adapter registered/);
  });
});

describe('PipelineService — stage 1: schema', () => {
  it('rejects a schema-invalid candidate without sending it, and records why', async () => {
    const h = setup();
    // 21 keywords: one past what dm-contract.md allows.
    const { signalId, status } = await submit(
      h,
      candidate({ keywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) }),
    );

    expect(status).toBe(SignalStatus.REJECTED_SCHEMA);
    expect(h.http.posts).toHaveLength(0);
    expect(h.signals.rows.get(signalId)?.dmResponse).toMatchObject({
      error: 'VALIDATION_FAILED_LOCAL',
      details: [{ field: 'keywords' }],
    });
    expect(h.fingerprints.hashes.size).toBe(0);
  });

  it('still ledgers a candidate too broken to fingerprint', async () => {
    const h = setup();
    const { signalId, status } = await submit(h, candidate({ topic: undefined, tone: 42 }));

    expect(status).toBe(SignalStatus.REJECTED_SCHEMA);
    const row = h.signals.rows.get(signalId);
    expect(row?.adapterKey).toBe('manual');
    expect(row?.fingerprint).toBe('');
  });

  it('rejects a candidate whose adapterKey is not the run it arrived in', async () => {
    const h = setup();
    const result = await h.pipeline.process(candidate({ adapterKey: 'search' }), {
      adapterKey: 'manual',
      startedAt: NOW,
      trigger: 'push',
    });
    expect(result.status).toBe(SignalStatus.REJECTED_SCHEMA);
  });
});

describe('PipelineService — stage 2: policy screen', () => {
  const rule: PolicyRule = { pattern: 'forbidden', match: 'word', scope: 'all', reason: 'test rule' };

  it('passes everything through with the shipped, empty denylist', async () => {
    const h = setup({ rules: [] });
    expect((await submit(h, candidate({ topic: 'forbidden' }))).status).toBe(SignalStatus.POSTED);
  });

  it('rejects a match, records the rule, and neither sends, fingerprints nor alerts', async () => {
    const h = setup({ rules: [rule] });
    const { signalId, status } = await submit(h, candidate({ keywords: ['totally forbidden'] }));

    expect(status).toBe(SignalStatus.REJECTED_POLICY);
    expect(h.signals.rows.get(signalId)?.dmResponse).toEqual({
      error: 'POLICY_REJECTED',
      rule: { pattern: 'forbidden', match: 'word', scope: 'all', reason: 'test rule' },
    });
    expect(h.http.posts).toHaveLength(0);
    // No fingerprint: a denylist edit must take effect on the very next candidate.
    expect(h.fingerprints.hashes.size).toBe(0);
    expect(h.notify.sent).toHaveLength(0);
  });

  it('runs after schema and before the tone gate', async () => {
    const h = setup({ rules: [rule], tones: ['Professional'] });
    expect((await submit(h, candidate({ topic: 'forbidden', tone: 'Sarcastic' }))).status).toBe(
      SignalStatus.REJECTED_POLICY,
    );
    expect((await submit(h, candidate({ topic: 'forbidden', keywords: Array(21).fill('k') }))).status).toBe(
      SignalStatus.REJECTED_SCHEMA,
    );
  });
});

describe('PipelineService — stage 3: tone gate', () => {
  it('rejects an unknown tone before dispatch and alerts once per adapter', async () => {
    const h = setup({ tones: ['Professional', 'Humor'] });

    const first = await submit(h, candidate({ tone: 'Sarcastic' }));
    expect(first.status).toBe(SignalStatus.REJECTED_TONE);
    expect(h.http.posts).toHaveLength(0);
    expect(h.signals.rows.get(first.signalId)?.dmResponse).toMatchObject({
      error: 'TONE_REJECTED',
      tone: 'Sarcastic',
      knownTones: ['Professional', 'Humor'],
    });
    expect(h.notify.kinds()).toEqual(['tone_rejection']);

    // Same adapter, same day: ledgered again, but no second email.
    const second = await submit(h, candidate({ tone: 'Sarcastic' }));
    expect(second.status).toBe(SignalStatus.REJECTED_TONE);
    expect(h.notify.kinds()).toEqual(['tone_rejection']);
    expect(h.notify.throttledKeys).toEqual(['tone_rejection:manual', 'tone_rejection:manual']);
  });

  it('lets a valid tone through', async () => {
    const h = setup({ tones: ['Professional', 'Humor'] });
    expect((await submit(h, candidate({ tone: 'Professional' }))).status).toBe(SignalStatus.POSTED);
  });

  it('skips rather than rejects when there is no taxonomy', async () => {
    const h = setup({ tones: null });
    expect((await submit(h, candidate({ tone: 'Anything' }))).status).toBe(SignalStatus.POSTED);
    expect(h.notify.sent).toHaveLength(0);
  });

  it('skips rather than rejects when DM publishes no tones', async () => {
    const h = setup({ tones: 'absent' });
    expect((await submit(h, candidate({ tone: 'Anything' }))).status).toBe(SignalStatus.POSTED);
    expect(h.notify.sent).toHaveLength(0);
  });

  it('runs before dedup, so a rejected candidate never suppresses its correction', async () => {
    const h = setup({ tones: ['Professional'] });
    await submit(h, candidate({ tone: 'Sarcastic' }));
    expect(h.fingerprints.hashes.size).toBe(0);
    expect((await submit(h, candidate({ tone: 'Professional' }))).status).toBe(SignalStatus.POSTED);
  });
});

describe('PipelineService — stages 4–5: fingerprint and dedup', () => {
  it('suppresses an identical resubmission inside the window and records it', async () => {
    const h = setup();
    const first = await submit(h);
    const second = await submit(h);

    expect(first.status).toBe(SignalStatus.POSTED);
    expect(second.status).toBe(SignalStatus.SUPPRESSED);
    expect(h.http.posts).toHaveLength(1);

    // Enough context on the suppressed row to audit what dedup is eating.
    const row = h.signals.rows.get(second.signalId);
    expect(row).toMatchObject({
      status: SignalStatus.SUPPRESSED,
      adapterKey: 'manual',
      topic: 'Trades',
      fingerprint: h.signals.rows.get(first.signalId)?.fingerprint,
      attempts: 0,
    });
    expect(row?.dmResponse).toMatchObject({
      dedup: 'SUPPRESSED',
      coveredBySignalId: first.signalId,
      suppressUntil: new Date(NOW.getTime() + 7 * DAY_MS).toISOString(),
    });
  });

  it('treats case and surrounding whitespace as the same signal', async () => {
    const h = setup();
    await submit(h);
    expect((await submit(h, candidate({ topic: '  trades ', subtopic: 'WELDING' }))).status).toBe(
      SignalStatus.SUPPRESSED,
    );
  });

  it('does not suppress a different subtopic', async () => {
    const h = setup();
    await submit(h);
    expect((await submit(h, candidate({ subtopic: 'Plumbing' }))).status).toBe(SignalStatus.POSTED);
  });

  it('still suppresses one millisecond before the window ends', async () => {
    const h = setup();
    await submit(h);
    h.clock.advance(7 * DAY_MS - 1);
    expect((await submit(h)).status).toBe(SignalStatus.SUPPRESSED);
  });

  it('refires at the boundary: suppressUntil exactly now has lapsed', async () => {
    const h = setup();
    await submit(h);
    h.clock.advance(7 * DAY_MS);
    expect((await submit(h)).status).toBe(SignalStatus.POSTED);
  });

  it('opens a fresh window when it refires after expiry', async () => {
    const h = setup();
    await submit(h);
    h.clock.advance(8 * DAY_MS);
    const refire = await submit(h);
    expect(refire.status).toBe(SignalStatus.POSTED);
    expect((await submit(h)).status).toBe(SignalStatus.SUPPRESSED);
    expect(h.signals.rows.get((await submit(h)).signalId)?.dmResponse).toMatchObject({
      coveredBySignalId: refire.signalId,
    });
  });

  it('keeps adapters in separate fingerprint spaces', async () => {
    const h = setup();
    const url = 'https://a.test/x';
    await submit(h, candidate({ adapterKey: 'search', platform: 'Web', sourceUrl: url, topic: 'Trades' }));
    expect((await submit(h, candidate())).status).toBe(SignalStatus.POSTED);
  });
});

describe('PipelineService — DRY_RUN and budgets', () => {
  it('runs every stage and ends dry_run without a request', async () => {
    const h = setup({ dryRun: true });
    const { signalId, status } = await submit(h);
    expect(status).toBe(SignalStatus.DRY_RUN);
    expect(h.http.posts).toHaveLength(0);
    expect(h.signals.rows.get(signalId)?.postedAt).toEqual(NOW);
  });

  it('dedups in dry-run too: first dry_run, repeat suppressed', async () => {
    const h = setup({ dryRun: true });
    expect((await submit(h)).status).toBe(SignalStatus.DRY_RUN);
    expect((await submit(h)).status).toBe(SignalStatus.SUPPRESSED);
  });

  it('counts dry_run but not suppressed or rejected rows toward the cap', async () => {
    const h = setup({ dryRun: true, manualBudget: 2, tones: ['Professional'] });

    expect((await submit(h)).status).toBe(SignalStatus.DRY_RUN); // 1 of 2
    expect((await submit(h)).status).toBe(SignalStatus.SUPPRESSED); // not counted
    expect((await submit(h, candidate({ tone: 'Sarcastic', subtopic: 'X' }))).status).toBe(
      SignalStatus.REJECTED_TONE,
    ); // not counted
    expect((await submit(h, candidate({ subtopic: 'Plumbing' }))).status).toBe(SignalStatus.DRY_RUN); // 2 of 2
    const over = await submit(h, candidate({ subtopic: 'Electrical' }));
    expect(over).toMatchObject({ status: SignalStatus.PENDING, parkedReason: 'budget_exhausted' });
  });
});

describe('PipelineService — payload assembly', () => {
  it('moves taxonomyAligned into extensions and drops adapterKey', async () => {
    const h = setup();
    await submit(h, candidate({ taxonomyAligned: false, extensions: { source: 'test' } }));

    const payload = h.http.posts[0]?.payload as Record<string, unknown>;
    expect(payload['adapterKey']).toBeUndefined();
    expect(payload['taxonomyAligned']).toBeUndefined();
    expect(payload['extensions']).toEqual({ source: 'test', taxonomyAligned: false });
  });

  it('stamps the configured generator sourceKey', async () => {
    const h = setup();
    await submit(h);
    expect((h.http.posts[0]?.payload as Record<string, unknown>)['sourceKey']).toBe('signalgen-v1');
  });

  it('omits fields the adapter left undefined', async () => {
    const h = setup();
    await submit(h, candidate({ subtopic: undefined }));
    expect('subtopic' in (h.http.posts[0]?.payload as Record<string, unknown>)).toBe(false);
  });
});
