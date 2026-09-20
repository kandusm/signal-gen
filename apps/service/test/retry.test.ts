import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../src/common';
import {
  DmClient,
  INLINE_RETRY_WAIT_CAP_MS,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_MS,
  RateLimitService,
  classifyStatus,
  nextRetryDelayMs,
  parseRetryAfterSeconds,
} from '../src/dm';
import { SignalStatus } from '../src/persistence';
import {
  FakeConfigService,
  FakeDmHttpClient,
  FakeNotifyService,
  FakeSignalRepository,
  httpResponse,
  transportError,
} from './helpers/fakes';

const NOW = new Date('2026-09-20T12:00:00.000Z');

describe('classifyStatus', () => {
  it.each([
    [202, 'accepted'],
    [200, 'duplicate'],
    [201, 'accepted_undocumented'],
    [204, 'accepted_undocumented'],
    [429, 'rate_limited'],
    [400, 'permanent'],
    [401, 'permanent'],
    [403, 'permanent'],
    [404, 'permanent'],
    [409, 'permanent'],
    [301, 'permanent'],
    [500, 'retryable'],
    [502, 'retryable'],
    [503, 'retryable'],
  ])('maps HTTP %i to %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});

describe('nextRetryDelayMs', () => {
  it('follows the 1m/5m/30m/2h/6h schedule', () => {
    expect(RETRY_SCHEDULE_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(300_000);
    expect(nextRetryDelayMs(3)).toBe(1_800_000);
    expect(nextRetryDelayMs(4)).toBe(7_200_000);
    expect(nextRetryDelayMs(5)).toBe(21_600_000);
  });

  it('returns null once the schedule is spent', () => {
    expect(nextRetryDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(nextRetryDelayMs(MAX_ATTEMPTS + 5)).toBeNull();
  });

  it('rejects a nonsensical attempt count', () => {
    expect(() => nextRetryDelayMs(0)).toThrow();
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterSeconds('42', NOW)).toBe(42);
    expect(parseRetryAfterSeconds('  42  ', NOW)).toBe(42);
  });

  it('reads an HTTP-date, as RFC 9110 also permits', () => {
    const in90s = new Date(NOW.getTime() + 90_000).toUTCString();
    expect(parseRetryAfterSeconds(in90s, NOW)).toBe(90);
  });

  it('clamps a date already in the past to zero', () => {
    const past = new Date(NOW.getTime() - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(past, NOW)).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfterSeconds(null, NOW)).toBeNull();
    expect(parseRetryAfterSeconds(undefined, NOW)).toBeNull();
    expect(parseRetryAfterSeconds('soon', NOW)).toBeNull();
  });
});

/** Taxonomy stub that accepts every tone, so the gate never interferes. */
const permissiveTaxonomy = {
  async isValidTone() {
    return true as const;
  },
  peek() {
    return null;
  },
};

interface Harness {
  clock: Clock & { advance(ms: number): void };
  signals: FakeSignalRepository;
  http: FakeDmHttpClient;
  notify: FakeNotifyService;
  dm: DmClient;
  slept: number[];
}

function setup(results: ReturnType<typeof httpResponse>[], options: { dryRun?: boolean } = {}): Harness {
  const clock = fixedClock(NOW);
  const signals = new FakeSignalRepository(clock);
  const http = new FakeDmHttpClient(results);
  const notify = new FakeNotifyService();
  const config = new FakeConfigService({
    dryRun: options.dryRun ?? false,
    budgets: { manual: 50, reddit: 100 },
  });
  const rateLimit = new RateLimitService(clock);
  const budget = {
    async check() {
      return { allowed: true as const, usage: { total: 0, byAdapter: {} } };
    },
    async usage() {
      return { total: 0, byAdapter: {} };
    },
  };
  const slept: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
    clock.advance(ms);
  };

  const dm = new DmClient(
    config as never,
    http as never,
    signals as never,
    budget as never,
    rateLimit,
    permissiveTaxonomy as never,
    notify as never,
    clock,
    sleep,
  );

  return { clock, signals, http, notify, dm, slept };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    adapterKey: 'manual',
    capturedAt: NOW.toISOString(),
    topic: 'Trades',
    subtopic: 'Welding',
    tone: 'Professional',
    platform: 'LinkedIn',
    taxonomyAligned: true,
    ...overrides,
  } as never;
}

const ACCEPTED = () => httpResponse(202, { signalId: 'x', status: 'ACCEPTED', matchingScheduled: true });
const DUPLICATE = () =>
  httpResponse(200, {
    signalId: 'x',
    status: 'DUPLICATE',
    originalCapturedAt: '2026-09-19T10:00:00Z',
  });

describe('DmClient — ledger ordering', () => {
  it('writes a pending ledger row before the first network attempt', async () => {
    const clock = fixedClock(NOW);
    const signals = new FakeSignalRepository(clock);
    const notify = new FakeNotifyService();
    const observed: string[] = [];

    // Records the ledger state as it looked at the moment the POST was made.
    const http = {
      async postSignal(_payload: unknown, signalId: string) {
        observed.push(signals.rows.get(signalId)?.status ?? 'ABSENT');
        return ACCEPTED();
      },
    };

    const dm = new DmClient(
      new FakeConfigService({ dryRun: false, budgets: { manual: 50 } }) as never,
      http as never,
      signals as never,
      {
        async check() {
          return { allowed: true as const, usage: { total: 0, byAdapter: {} } };
        },
        async usage() {
          return { total: 0, byAdapter: {} };
        },
      } as never,
      new RateLimitService(clock),
      permissiveTaxonomy as never,
      notify as never,
      clock,
    );

    await dm.postSignal(candidate());
    expect(observed).toEqual([SignalStatus.PENDING]);
  });

  it('sends the same signalId in the body and the Idempotency-Key', async () => {
    const h = setup([ACCEPTED()]);
    const result = await h.dm.postSignal(candidate());

    const post = h.http.posts[0];
    expect(post?.signalId).toBe(result.signalId);
    expect((post?.payload as { signalId: string }).signalId).toBe(result.signalId);
  });

  it('prefixes the signalId by adapter', async () => {
    const manual = setup([ACCEPTED()]);
    expect((await manual.dm.postSignal(candidate())).signalId).toMatch(/^man_/);

    const reddit = setup([ACCEPTED()]);
    expect(
      (await reddit.dm.postSignal(candidate({ adapterKey: 'reddit', platform: 'reddit' }))).signalId,
    ).toMatch(/^rdt_/);
  });
});

describe('DmClient — terminal transitions', () => {
  it('202 marks the row posted and stamps postedAt', async () => {
    const h = setup([ACCEPTED()]);
    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(status).toBe(SignalStatus.POSTED);
    const row = h.signals.rows.get(signalId);
    expect(row?.status).toBe(SignalStatus.POSTED);
    expect(row?.dmStatusCode).toBe(202);
    expect(row?.postedAt).toEqual(NOW);
    expect(row?.attempts).toBe(1);
    expect(h.notify.sent).toHaveLength(0);
  });

  it('200 DUPLICATE also counts as posted, and raises no alert', async () => {
    const h = setup([DUPLICATE()]);
    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(status).toBe(SignalStatus.POSTED);
    const row = h.signals.rows.get(signalId);
    expect(row?.status).toBe(SignalStatus.POSTED);
    expect(row?.dmStatusCode).toBe(200);
    expect(row?.postedAt).toEqual(NOW);
    // A duplicate is an anomaly worth logging, not worth an email: DM
    // confirmed it holds the signal, which is the outcome we wanted.
    expect(h.notify.sent).toHaveLength(0);
  });

  it('400 is permanent, alerts, and never retries', async () => {
    const h = setup([
      httpResponse(400, {
        error: 'VALIDATION_FAILED',
        details: [{ field: 'tone', message: "Value 'Sarcastic' is not a recognized tone" }],
      }),
    ]);
    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(status).toBe(SignalStatus.FAILED_PERMANENT);
    const row = h.signals.rows.get(signalId);
    expect(row?.dmStatusCode).toBe(400);
    expect(row?.nextAttemptAt).toBeNull();
    expect(row?.dmResponse).toContain('VALIDATION_FAILED');
    expect(h.notify.kinds()).toEqual(['permanent_failure']);
    expect(h.http.posts).toHaveLength(1);
  });

  it('401 is permanent too', async () => {
    const h = setup([httpResponse(401, null)]);
    const { status } = await h.dm.postSignal(candidate());
    expect(status).toBe(SignalStatus.FAILED_PERMANENT);
    expect(h.notify.kinds()).toEqual(['permanent_failure']);
  });
});

describe('DmClient — retry schedule', () => {
  it('books the first retry one minute out after a 500', async () => {
    const h = setup([httpResponse(500, { error: 'boom' })]);
    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(status).toBe(SignalStatus.PENDING);
    const row = h.signals.rows.get(signalId);
    expect(row?.status).toBe(SignalStatus.PENDING);
    expect(row?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(row?.dmStatusCode).toBe(500);
    expect(h.notify.sent).toHaveLength(0);
  });

  it('treats a transport error as retryable and records the reason', async () => {
    const h = setup([transportError('ECONNREFUSED')]);
    const { signalId } = await h.dm.postSignal(candidate());

    const row = h.signals.rows.get(signalId);
    expect(row?.status).toBe(SignalStatus.PENDING);
    expect(row?.dmStatusCode).toBeNull();
    expect(row?.dmResponse).toContain('ECONNREFUSED');
    expect(row?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('walks the whole schedule, then parks as failed and alerts once', async () => {
    // One 503 per allowed attempt: the initial one plus one per schedule entry.
    const h = setup(Array.from({ length: MAX_ATTEMPTS }, () => httpResponse(503, { error: 'unavailable' })));
    const row = h.signals.seed({ id: 'man_walk', adapterKey: 'manual' });

    // Each pass is one sweep tick: dispatch, check the booking, wait it out.
    for (const [index, delay] of RETRY_SCHEDULE_MS.entries()) {
      const result = await h.dm.dispatch(h.signals.rows.get(row.id) as never);

      expect(result.status).toBe(SignalStatus.PENDING);
      expect(result.parkedReason).toBe('retry_scheduled');
      expect(h.signals.rows.get(row.id)?.attempts).toBe(index + 1);
      expect(h.signals.rows.get(row.id)?.nextAttemptAt).toEqual(
        new Date(h.clock().getTime() + delay),
      );

      h.clock.advance(delay);
    }

    // The schedule is spent; the next failure parks the row for good.
    const final = await h.dm.dispatch(h.signals.rows.get(row.id) as never);

    expect(final.status).toBe(SignalStatus.FAILED);
    const parked = h.signals.rows.get(row.id);
    expect(parked?.status).toBe(SignalStatus.FAILED);
    expect(parked?.attempts).toBe(MAX_ATTEMPTS);
    expect(parked?.nextAttemptAt).toBeNull();
    expect(h.notify.kinds()).toEqual(['retry_exhaustion']);
  });
});

describe('DmClient — 429 handling', () => {
  it('always alerts, honours Retry-After inline, and retries', async () => {
    const h = setup([
      httpResponse(429, { error: 'RATE_LIMITED', limit: '10/min', retryAfter: 42 }, '42'),
      ACCEPTED(),
    ]);

    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(h.slept).toEqual([42_000]);
    expect(status).toBe(SignalStatus.POSTED);
    expect(h.signals.rows.get(signalId)?.attempts).toBe(2);
    // A 429 is an accounting bug on our side, so it is alerted even though the
    // retry succeeded.
    expect(h.notify.kinds()).toEqual(['rate_limited']);
  });

  it('schedules instead of blocking when Retry-After exceeds the inline cap', async () => {
    const tooLong = Math.ceil(INLINE_RETRY_WAIT_CAP_MS / 1000) + 60;
    const h = setup([
      httpResponse(429, { error: 'RATE_LIMITED', limit: '10/min', retryAfter: tooLong }, String(tooLong)),
    ]);

    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(h.slept).toEqual([]);
    expect(status).toBe(SignalStatus.PENDING);
    // The longer of Retry-After and the schedule wins, so we never come back
    // earlier than DM asked.
    expect(h.signals.rows.get(signalId)?.nextAttemptAt).toEqual(
      new Date(NOW.getTime() + tooLong * 1000),
    );
    expect(h.notify.kinds()).toEqual(['rate_limited']);
  });

  it('does not loop inline on a second consecutive 429', async () => {
    const h = setup([
      httpResponse(429, { error: 'RATE_LIMITED', limit: '10/min', retryAfter: 5 }, '5'),
      httpResponse(429, { error: 'RATE_LIMITED', limit: '10/min', retryAfter: 5 }, '5'),
    ]);

    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(h.slept).toEqual([5_000]);
    expect(status).toBe(SignalStatus.PENDING);
    expect(h.signals.rows.get(signalId)?.attempts).toBe(2);
    expect(h.notify.kinds()).toEqual(['rate_limited', 'rate_limited']);
    expect(h.http.posts).toHaveLength(2);
  });

  it('falls back to the schedule when a 429 carries no Retry-After', async () => {
    const h = setup([httpResponse(429, { error: 'RATE_LIMITED', limit: '10/min', retryAfter: 0 })]);

    const { signalId } = await h.dm.postSignal(candidate());

    expect(h.slept).toEqual([]);
    expect(h.signals.rows.get(signalId)?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
  });
});

describe('DmClient — guards', () => {
  it('DRY_RUN writes a dry_run row and makes no request', async () => {
    const h = setup([], { dryRun: true });
    const { signalId, status } = await h.dm.postSignal(candidate());

    expect(status).toBe(SignalStatus.DRY_RUN);
    expect(h.signals.rows.get(signalId)?.status).toBe(SignalStatus.DRY_RUN);
    expect(h.signals.rows.get(signalId)?.attempts).toBe(0);
    expect(h.http.posts).toHaveLength(0);
  });

  it('rejects a schema-invalid payload without sending it', async () => {
    const h = setup([]);
    // 21 keywords: one past what dm-contract.md allows.
    const { signalId, status } = await h.dm.postSignal(
      candidate({ keywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) }),
    );

    expect(status).toBe(SignalStatus.REJECTED_SCHEMA);
    expect(h.http.posts).toHaveLength(0);
    const row = h.signals.rows.get(signalId);
    expect(row?.status).toBe(SignalStatus.REJECTED_SCHEMA);
    expect(row?.dmResponse).toContain('keywords');
  });

  it('parks the row when the local token bucket is empty', async () => {
    // Eleven scripted successes: ten drain the bucket, the eleventh is for
    // the retry after it refills.
    const h = setup(Array.from({ length: 11 }, () => ACCEPTED()));

    for (let i = 0; i < 10; i += 1) {
      expect((await h.dm.postSignal(candidate())).status).toBe(SignalStatus.POSTED);
    }

    const eleventh = await h.dm.postSignal(candidate());
    expect(eleventh.status).toBe(SignalStatus.PENDING);
    expect(eleventh.parkedReason).toBe('rate_limited_local');
    expect(h.http.posts).toHaveLength(10);

    // The bucket refills continuously, so a token is back six seconds later.
    h.clock.advance(6_000);
    const row = h.signals.rows.get(eleventh.signalId);
    expect((await h.dm.dispatch(row as never)).status).toBe(SignalStatus.POSTED);
  });
});

describe('DmClient — tone gate', () => {
  function toneHarness(tones: string[] | null) {
    const clock = fixedClock(NOW);
    const signals = new FakeSignalRepository(clock);
    const http = new FakeDmHttpClient([ACCEPTED(), ACCEPTED()]);
    const notify = new FakeNotifyService();
    const taxonomy = {
      async isValidTone(tone: string) {
        if (tones === null) return 'unknown' as const;
        return tones.includes(tone);
      },
      peek() {
        return tones === null ? null : { taxonomy: { categories: [], tones }, fetchedAt: NOW, fromSnapshot: false };
      },
    };
    const dm = new DmClient(
      new FakeConfigService({ dryRun: false, budgets: { manual: 50 } }) as never,
      http as never,
      signals as never,
      {
        async check() {
          return { allowed: true as const, usage: { total: 0, byAdapter: {} } };
        },
        async usage() {
          return { total: 0, byAdapter: {} };
        },
      } as never,
      new RateLimitService(clock),
      taxonomy as never,
      notify as never,
      clock,
    );
    return { dm, signals, http, notify };
  }

  it('rejects an unknown tone before dispatch and alerts once per adapter', async () => {
    const h = toneHarness(['Professional', 'Humor']);

    const first = await h.dm.postSignal(candidate({ tone: 'Sarcastic' }));
    expect(first.status).toBe(SignalStatus.REJECTED_TONE);
    expect(h.http.posts).toHaveLength(0);
    expect(h.signals.rows.get(first.signalId)?.dmResponse).toContain('Sarcastic');
    expect(h.notify.kinds()).toEqual(['tone_rejection']);

    // Same adapter, same day: ledgered again, but no second email.
    const second = await h.dm.postSignal(candidate({ tone: 'Sarcastic' }));
    expect(second.status).toBe(SignalStatus.REJECTED_TONE);
    expect(h.notify.kinds()).toEqual(['tone_rejection']);
    expect(h.notify.throttledKeys).toEqual(['tone_rejection:manual', 'tone_rejection:manual']);
  });

  it('lets a valid tone through', async () => {
    const h = toneHarness(['Professional', 'Humor']);
    expect((await h.dm.postSignal(candidate({ tone: 'Professional' }))).status).toBe(
      SignalStatus.POSTED,
    );
  });

  it('does not reject when there is no taxonomy to check against', async () => {
    // dm-contract.md: an unrecognised tone still matches via Tier 2/3, so a DM
    // outage must not turn into a total rejection.
    const h = toneHarness(null);
    expect((await h.dm.postSignal(candidate({ tone: 'Anything' }))).status).toBe(
      SignalStatus.POSTED,
    );
    expect(h.notify.sent).toHaveLength(0);
  });
});

describe('DmClient — payload assembly', () => {
  it('moves taxonomyAligned into extensions and drops adapterKey', async () => {
    const harness = setup([ACCEPTED()]);
    await harness.dm.postSignal(
      candidate({ taxonomyAligned: false, extensions: { source: 'test' } }),
    );

    const payload = harness.http.posts[0]?.payload as Record<string, unknown>;
    expect(payload['adapterKey']).toBeUndefined();
    expect(payload['taxonomyAligned']).toBeUndefined();
    expect(payload['extensions']).toEqual({ source: 'test', taxonomyAligned: false });
  });

  it('stamps the configured generator sourceKey', async () => {
    const harness = setup([ACCEPTED()]);
    await harness.dm.postSignal(candidate());
    const payload = harness.http.posts[0]?.payload as Record<string, unknown>;
    expect(payload['sourceKey']).toBe('signalgen-v1');
  });

  it('omits fields the adapter left undefined', async () => {
    const harness = setup([ACCEPTED()]);
    await harness.dm.postSignal(candidate({ subtopic: undefined }));
    const payload = harness.http.posts[0]?.payload as Record<string, unknown>;
    expect('subtopic' in payload).toBe(false);
  });
});
