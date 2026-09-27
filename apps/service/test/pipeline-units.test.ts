import { describe, expect, it } from 'vitest';
import type { CandidateSignal } from '@signalgen/contract';
import { dmSignalPayloadSchema } from '@signalgen/contract';
import {
  SIGNAL_ID_MAX_LENGTH,
  TokenBucket,
  buildDmPayload,
  buildSignalId,
  deriveShortcode,
} from '../src/dm';
import { ManualAdapter } from '../src/adapters/manual';
import { fingerprintOf } from '../src/pipeline';

describe('deriveShortcode', () => {
  it('derives a shortcode for an adapter config has not registered', () => {
    // The configured ADAPTER_SHORTCODES map is the real source; this is the
    // fallback that keeps a new adapter from producing a malformed id before
    // someone remembers to add it.
    expect(deriveShortcode('calendar')).toBe('cale');
    expect(deriveShortcode('Google-Trends')).toBe('goog');
  });

  it('refuses an adapter key with nothing to derive from', () => {
    expect(() => deriveShortcode('---')).toThrow();
  });
});

describe('buildSignalId', () => {
  it('formats as shortcode_ULID using the shortcode it is given', () => {
    expect(buildSignalId('manual', 'man', '01J8ZYXWVUTSRQPONMLKJIHGFE')).toBe(
      'man_01J8ZYXWVUTSRQPONMLKJIHGFE',
    );
    expect(buildSignalId('search', 'srch', '01J8ZYXWVUTSRQPONMLKJIHGFE')).toBe(
      'srch_01J8ZYXWVUTSRQPONMLKJIHGFE',
    );
  });

  it('falls back to a derived shortcode when config supplies none', () => {
    expect(buildSignalId('manual', undefined, '01J8ZYXWVUTSRQPONMLKJIHGFE')).toBe(
      'manu_01J8ZYXWVUTSRQPONMLKJIHGFE',
    );
  });

  it('stays inside the 64-character contract limit', () => {
    const id = buildSignalId('search', 'srch');
    expect(id.length).toBeLessThanOrEqual(SIGNAL_ID_MAX_LENGTH);
    expect(dmSignalPayloadSchema.shape.signalId.safeParse(id).success).toBe(true);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => buildSignalId('manual', 'man')));
    expect(ids.size).toBe(500);
  });

  it('sorts lexicographically by creation order, as ULIDs should', () => {
    const first = buildSignalId('manual', 'man', '01J8ZYXWVUTSRQPONMLKJIHGFE');
    const second = buildSignalId('manual', 'man', '01J8ZYXWVUTSRQPONMLKJIHGFF');
    expect([second, first].sort()).toEqual([first, second]);
  });

  it('rejects an id that would exceed the contract limit', () => {
    expect(() => buildSignalId('manual', 'man', 'x'.repeat(SIGNAL_ID_MAX_LENGTH))).toThrow(/64/);
  });
});

describe('fingerprintOf', () => {
  it('hashes adapterKey | material as sha256 hex', () => {
    expect(fingerprintOf('manual', 'x|y')).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf('manual', 'x|y')).toBe(fingerprintOf('manual', 'x|y'));
  });

  it('separates adapters, so per-source suppression windows can differ', () => {
    // architecture-spec.md section 8 gives search a 21-day window and manual a
    // 7-day one; that only works if the adapter is part of the hash.
    expect(fingerprintOf('search', 'x|y')).not.toBe(fingerprintOf('manual', 'x|y'));
  });

  it('matches the Phase 0 manual fingerprint, so existing ledger rows stay comparable', () => {
    // Phase 0 hashed "manual|trades|welding" directly; the seed row
    // man_01M3HSMPFGC6AGM3A2KQKHY9DA carries this value.
    expect(fingerprintOf('manual', 'trades|welding')).toBe(
      'ea6bb160970c13ea18b68b3bbe1a1ee9fdb986bd2592225a5220dbdfc5488b6f',
    );
  });
});

describe('ManualAdapter.fingerprintMaterial', () => {
  const adapter = new ManualAdapter();
  const material = (topic: string, subtopic?: string) =>
    adapter.fingerprintMaterial({ topic, subtopic } as CandidateSignal);

  it('is lowercase(trim(topic)) | lowercase(trim(subtopic ?? ""))', () => {
    expect(material('Pipe Welding', 'Safety')).toBe('pipe welding|safety');
  });

  it('normalises case and surrounding whitespace', () => {
    expect(material('  pipe welding  ', 'SAFETY')).toBe(material('Pipe Welding', 'Safety'));
  });

  it('treats a missing subtopic and a blank one alike', () => {
    expect(material('X')).toBe(material('X', '  '));
  });

  it('changes when the topic changes', () => {
    expect(material('Stick Welding', 'Safety')).not.toBe(material('Pipe Welding', 'Safety'));
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
