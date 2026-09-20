import { describe, expect, it } from 'vitest';
import {
  EXTENSIONS_MAX_SERIALIZED_BYTES,
  dmSignalPayloadSchema,
  serializedByteLength,
} from '../src/payload';

/**
 * Transcribed verbatim from docs/dm-contract.md → "Request body". This object
 * is the line-by-line check the review gate calls for: if DM's documented
 * example stops parsing, the contract has moved.
 */
const DM_CONTRACT_SAMPLE_BODY = {
  signalId: 'sig_a1b2c3d4',
  capturedAt: '2026-09-20T14:30:00Z',
  sourceKey: 'trend-monitor-v1',

  topic: 'Pipe Welding',
  subtopic: 'Safety',
  tone: 'Professional',
  platform: 'LinkedIn',
  subplatform: 'Construction group',

  keywords: ['welding', 'PPE', 'hot work permit'],
  audience: 'trades professionals',

  sourceUrl: 'https://www.linkedin.com/posts/example',
  sourceAuthor: 'some-handle',
  sourceExcerpt: 'Short quote from the observed content (<500 chars)',
  engagementMetrics: {
    views: 12500,
    likes: 340,
    comments: 45,
    shares: 12,
  },

  observedAt: '2026-09-20T09:15:00Z',
  signalDecayHint: 'SHORT',

  extensions: {
    sourceSpecificField: '...',
  },
} as const;

/** Only the six fields dm-contract.md marks Required. */
const MINIMAL_BODY = {
  signalId: 'man_01J8ZYX',
  capturedAt: '2026-09-20T14:30:00Z',
  sourceKey: 'signalgen-v1',
  topic: 'Pipe Welding',
  tone: 'Professional',
  platform: 'LinkedIn',
} as const;

describe('dmSignalPayloadSchema — acceptance', () => {
  it('accepts the exact sample body from dm-contract.md', () => {
    const result = dmSignalPayloadSchema.safeParse(DM_CONTRACT_SAMPLE_BODY);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('accepts a body carrying only the required fields', () => {
    expect(dmSignalPayloadSchema.safeParse(MINIMAL_BODY).success).toBe(true);
  });

  it('accepts null engagement metrics ("nulls fine")', () => {
    const result = dmSignalPayloadSchema.safeParse({
      ...MINIMAL_BODY,
      engagementMetrics: { views: null, likes: null, comments: null, shares: null },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a UTC offset as well as a Z suffix', () => {
    const result = dmSignalPayloadSchema.safeParse({
      ...MINIMAL_BODY,
      capturedAt: '2026-09-20T16:30:00+02:00',
    });
    expect(result.success).toBe(true);
  });

  it.each(['IMMEDIATE', 'SHORT', 'EVERGREEN'])('accepts decay hint %s', (hint) => {
    expect(dmSignalPayloadSchema.safeParse({ ...MINIMAL_BODY, signalDecayHint: hint }).success).toBe(
      true,
    );
  });
});

/** Returns the dotted field paths that failed, for readable assertions. */
function failedPaths(body: unknown): string[] {
  const result = dmSignalPayloadSchema.safeParse(body);
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

/**
 * Returns the unknown keys zod rejected, as `parentPath.key`.
 * zod reports `unrecognized_keys` against the *containing* object, with the
 * offending keys in `issue.keys` — so the path alone cannot tell you which
 * key was unknown.
 */
function rejectedUnknownKeys(body: unknown): string[] {
  const result = dmSignalPayloadSchema.safeParse(body);
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key].join('.'))
      : [],
  );
}

describe('dmSignalPayloadSchema — rejection', () => {
  it('rejects a signalId longer than 64 characters', () => {
    expect(dmSignalPayloadSchema.safeParse({ ...MINIMAL_BODY, signalId: 'a'.repeat(64) }).success).toBe(
      true,
    );
    expect(failedPaths({ ...MINIMAL_BODY, signalId: 'a'.repeat(65) })).toContain('signalId');
  });

  it('rejects a 21st keyword', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `kw${i}`);
    expect(dmSignalPayloadSchema.safeParse({ ...MINIMAL_BODY, keywords: twenty }).success).toBe(true);
    expect(failedPaths({ ...MINIMAL_BODY, keywords: [...twenty, 'kw20'] })).toContain('keywords');
  });

  it('rejects extensions over 8KB serialized', () => {
    const underLimit = { blob: 'x'.repeat(8000) };
    expect(serializedByteLength(underLimit)).toBeLessThanOrEqual(EXTENSIONS_MAX_SERIALIZED_BYTES);
    expect(dmSignalPayloadSchema.safeParse({ ...MINIMAL_BODY, extensions: underLimit }).success).toBe(
      true,
    );

    const overLimit = { blob: 'x'.repeat(EXTENSIONS_MAX_SERIALIZED_BYTES + 1) };
    expect(failedPaths({ ...MINIMAL_BODY, extensions: overLimit })).toContain('extensions');
  });

  it('measures the extensions limit in UTF-8 bytes, not UTF-16 code units', () => {
    // 4096 multi-byte characters: 4096 UTF-16 units but 3 bytes each in UTF-8,
    // so this is ~12KB on the wire despite a short `.length`.
    const multiByte = { blob: '☃'.repeat(4096) };
    expect(JSON.stringify(multiByte).length).toBeLessThan(EXTENSIONS_MAX_SERIALIZED_BYTES);
    expect(serializedByteLength(multiByte)).toBeGreaterThan(EXTENSIONS_MAX_SERIALIZED_BYTES);
    expect(failedPaths({ ...MINIMAL_BODY, extensions: multiByte })).toContain('extensions');
  });

  it('rejects unknown top-level keys', () => {
    // taxonomyAligned is an internal CandidateSignal field. It must travel in
    // `extensions`, never as a top-level key — architecture-spec.md §5.
    expect(rejectedUnknownKeys({ ...MINIMAL_BODY, taxonomyAligned: true })).toContain(
      'taxonomyAligned',
    );
  });

  it('rejects unknown keys inside engagementMetrics', () => {
    // architecture-spec.md §9.3 proposes { score, comments, upvoteRatio } for
    // Reddit. Those are not contract keys; Phase 3 must map them.
    const unknown = rejectedUnknownKeys({
      ...MINIMAL_BODY,
      engagementMetrics: { score: 12, upvoteRatio: 0.9 },
    });
    expect(unknown).toContain('engagementMetrics.score');
    expect(unknown).toContain('engagementMetrics.upvoteRatio');
  });

  it('rejects a decay hint outside the enum', () => {
    expect(failedPaths({ ...MINIMAL_BODY, signalDecayHint: 'SOON' })).toContain('signalDecayHint');
  });

  it.each([
    ['sourceKey over 32 chars', { sourceKey: 'a'.repeat(33) }, 'sourceKey'],
    ['topic over 128 chars', { topic: 'a'.repeat(129) }, 'topic'],
    ['subtopic over 128 chars', { subtopic: 'a'.repeat(129) }, 'subtopic'],
    ['audience over 128 chars', { audience: 'a'.repeat(129) }, 'audience'],
    ['sourceExcerpt over 500 chars', { sourceExcerpt: 'a'.repeat(501) }, 'sourceExcerpt'],
    ['a non-URL sourceUrl', { sourceUrl: 'not-a-url' }, 'sourceUrl'],
    ['a non-ISO capturedAt', { capturedAt: '2026-09-20 14:30' }, 'capturedAt'],
    ['an empty required tone', { tone: '' }, 'tone'],
  ])('rejects %s', (_label, patch, expectedPath) => {
    expect(failedPaths({ ...MINIMAL_BODY, ...patch })).toContain(expectedPath);
  });

  it.each(['signalId', 'capturedAt', 'sourceKey', 'topic', 'tone', 'platform'])(
    'rejects a body missing required field %s',
    (field) => {
      const body: Record<string, unknown> = { ...MINIMAL_BODY };
      delete body[field];
      expect(failedPaths(body)).toContain(field);
    },
  );
});
