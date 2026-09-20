import { describe, expect, it } from 'vitest';
import { candidateSignalSchema } from '../src/candidate';
import { dmSignalPayloadSchema } from '../src/payload';

const CANDIDATE = {
  adapterKey: 'manual',
  capturedAt: '2026-09-20T14:30:00Z',
  topic: 'Pipe Welding',
  tone: 'Professional',
  platform: 'LinkedIn',
  taxonomyAligned: true,
} as const;

describe('candidateSignalSchema', () => {
  it('accepts a minimal candidate', () => {
    const result = candidateSignalSchema.safeParse(CANDIDATE);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('rejects signalId and sourceKey — the pipeline owns those', () => {
    expect(candidateSignalSchema.safeParse({ ...CANDIDATE, signalId: 'man_1' }).success).toBe(false);
    expect(candidateSignalSchema.safeParse({ ...CANDIDATE, sourceKey: 'signalgen-v1' }).success).toBe(
      false,
    );
  });

  it('requires an explicit taxonomyAligned decision', () => {
    const { taxonomyAligned: _omitted, ...withoutFlag } = CANDIDATE;
    expect(candidateSignalSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('inherits the wire field constraints it derives from', () => {
    expect(candidateSignalSchema.safeParse({ ...CANDIDATE, sourceExcerpt: 'a'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('carries every wire field except the two the pipeline assigns', () => {
    const wire = Object.keys(dmSignalPayloadSchema.shape).filter(
      (k) => k !== 'signalId' && k !== 'sourceKey',
    );
    const candidate = Object.keys(candidateSignalSchema.shape);
    expect(candidate).toEqual(expect.arrayContaining(wire));
    expect(candidate).toContain('adapterKey');
    expect(candidate).toContain('taxonomyAligned');
  });
});
