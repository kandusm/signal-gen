import { describe, expect, it } from 'vitest';
import type { CandidateSignal } from '@signalgen/contract';
import { dmSignalPayloadSchema } from '@signalgen/contract';
import {
  SIGNAL_ID_MAX_LENGTH,
  TokenBucket,
  buildDmPayload,
  buildSignalId,
  fingerprintFor,
  shortcodeFor,
} from '../src/dm';

describe('shortcodeFor', () => {
  it('uses the registered shortcodes', () => {
    expect(shortcodeFor('manual')).toBe('man');
    expect(shortcodeFor('reddit')).toBe('rdt');
  });

  it('derives a shortcode for an unregistered adapter', () => {
    // So a Phase 2 adapter cannot produce a malformed id before someone
    // remembers to register it.
    expect(shortcodeFor('calendar')).toBe('cal');
    expect(shortcodeFor('Google-Trends')).toBe('goo');
  });

  it('refuses an adapter key with nothing to derive from', () => {
    expect(() => shortcodeFor('---')).toThrow();
  });
});

describe('buildSignalId', () => {
  it('formats as shortcode_ULID', () => {
    expect(buildSignalId('manual', '01J8ZYXWVUTSRQPONMLKJIHGFE')).toBe(
      'man_01J8ZYXWVUTSRQPONMLKJIHGFE',
    );
  });

  it('stays inside the 64-character contract limit', () => {
    const id = buildSignalId('reddit');
    expect(id.length).toBeLessThanOrEqual(SIGNAL_ID_MAX_LENGTH);
    expect(dmSignalPayloadSchema.shape.signalId.safeParse(id).success).toBe(true);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => buildSignalId('manual')));
    expect(ids.size).toBe(500);
  });

  it('sorts lexicographically by creation order, as ULIDs should', () => {
    const first = buildSignalId('manual', '01J8ZYXWVUTSRQPONMLKJIHGFE');
    const second = buildSignalId('manual', '01J8ZYXWVUTSRQPONMLKJIHGFF');
    expect([second, first].sort()).toEqual([first, second]);
  });

  it('rejects an id that would exceed the contract limit', () => {
    expect(() => buildSignalId('manual', 'x'.repeat(SIGNAL_ID_MAX_LENGTH))).toThrow(/64/);
  });
});

describe('fingerprintFor', () => {
  const base = { adapterKey: 'manual', topic: 'Pipe Welding', subtopic: 'Safety' };

  it('is stable for the same inputs', () => {
    expect(fingerprintFor(base)).toBe(fingerprintFor({ ...base }));
  });

  it('normalises case and surrounding whitespace', () => {
    expect(fingerprintFor({ ...base, topic: '  pipe welding  ', subtopic: 'SAFETY' })).toBe(
      fingerprintFor(base),
    );
  });

  it('separates adapters, so per-source suppression windows can differ', () => {
    // architecture-spec.md section 8 gives reddit a 21-day window and manual a
    // 7-day one; that only works if the adapter is part of the hash.
    expect(fingerprintFor({ ...base, adapterKey: 'reddit' })).not.toBe(fingerprintFor(base));
  });

  it('distinguishes a missing subtopic from an empty one consistently', () => {
    const withUndefined = fingerprintFor({ adapterKey: 'manual', topic: 'X' });
    const withEmpty = fingerprintFor({ adapterKey: 'manual', topic: 'X', subtopic: '  ' });
    expect(withUndefined).toBe(withEmpty);
  });

  it('changes when the topic changes', () => {
    expect(fingerprintFor({ ...base, topic: 'Stick Welding' })).not.toBe(fingerprintFor(base));
  });

  it('produces a sha256 hex digest', () => {
    expect(fingerprintFor(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildDmPayload', () => {
  const candidate: CandidateSignal = {
    adapterKey: 'manual',
    capturedAt: '2026-09-20T14:30:00Z',
    topic: 'Trades',
    subtopic: 'Welding',
    tone: 'Professional',
    platform: 'LinkedIn',
    taxonomyAligned: true,
  };

  const identity = { signalId: 'man_01J8ZYX', sourceKey: 'signalgen-v1' };

  it('produces a payload that satisfies the wire contract', () => {
    const payload = buildDmPayload(candidate, identity);
    const result = dmSignalPayloadSchema.safeParse(payload);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('adds the two fields the pipeline owns', () => {
    const payload = buildDmPayload(candidate, identity);
    expect(payload['signalId']).toBe('man_01J8ZYX');
    expect(payload['sourceKey']).toBe('signalgen-v1');
  });

  it('removes the two internal fields', () => {
    const payload = buildDmPayload(candidate, identity);
    expect('adapterKey' in payload).toBe(false);
    expect('taxonomyAligned' in payload).toBe(false);
  });

  it('carries taxonomyAligned in extensions, where the strict schema allows it', () => {
    expect(buildDmPayload(candidate, identity)['extensions']).toEqual({ taxonomyAligned: true });
    expect(
      buildDmPayload({ ...candidate, taxonomyAligned: false }, identity)['extensions'],
    ).toEqual({ taxonomyAligned: false });
  });

  it('merges into an adapter-supplied extensions object without clobbering it', () => {
    const payload = buildDmPayload(
      { ...candidate, extensions: { subreddit: 'r/Welding', score: 412 } },
      identity,
    );
    expect(payload['extensions']).toEqual({
      subreddit: 'r/Welding',
      score: 412,
      taxonomyAligned: true,
    });
  });

  it('omits keys the adapter left undefined', () => {
    const payload = buildDmPayload({ ...candidate, subtopic: undefined }, identity);
    expect('subtopic' in payload).toBe(false);
  });
});

describe('TokenBucket', () => {
  function bucketAt(start = 0) {
    let now = start;
    const bucket = new TokenBucket(10, 60_000, () => now);
    return { bucket, advance: (ms: number) => (now += ms) };
  }

  it('allows a burst up to capacity, then refuses', () => {
    const { bucket } = bucketAt();
    for (let i = 0; i < 10; i += 1) expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('refills continuously rather than in a spike on the minute', () => {
    const { bucket, advance } = bucketAt();
    for (let i = 0; i < 10; i += 1) bucket.tryRemove();

    advance(5_999);
    expect(bucket.tryRemove()).toBe(false);

    advance(1);
    expect(bucket.tryRemove()).toBe(true);
  });

  it('never exceeds capacity however long it idles', () => {
    const { bucket, advance } = bucketAt();
    advance(60 * 60_000);
    expect(bucket.available()).toBe(10);

    for (let i = 0; i < 10; i += 1) expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('reports the wait until the next token', () => {
    const { bucket, advance } = bucketAt();
    for (let i = 0; i < 10; i += 1) bucket.tryRemove();

    expect(bucket.msUntilNextToken()).toBe(6_000);
    advance(3_000);
    expect(bucket.msUntilNextToken()).toBe(3_000);
  });

  it('reports zero wait while tokens remain', () => {
    const { bucket } = bucketAt();
    expect(bucket.msUntilNextToken()).toBe(0);
  });

  it('holds to 10 per minute over a sustained run', () => {
    // The contract is 10/min; a bucket that drifts above that provokes the
    // 429s the whole design exists to avoid.
    const { bucket, advance } = bucketAt();
    let granted = 0;
    for (let tick = 0; tick < 600; tick += 1) {
      if (bucket.tryRemove()) granted += 1;
      advance(100);
    }
    // 60s elapsed: the initial burst of 10 plus one minute of refill.
    expect(granted).toBeLessThanOrEqual(20);
    expect(granted).toBeGreaterThanOrEqual(19);
  });
});
