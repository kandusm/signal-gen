import { describe, expect, it } from 'vitest';
import { DISPLAY_TIME_ZONE, isUtcWireTimestamp, toWireTimestamp } from '../src/common';
import { dmSignalPayloadSchema } from '@signalgen/contract';

/**
 * build-plan.md section 9: storage and wire timestamps are UTC ISO-8601.
 * The column type and TZ=UTC carry most of this; these tests pin the part
 * that lives in code.
 */
describe('toWireTimestamp', () => {
  it('emits UTC with a Z suffix', () => {
    expect(toWireTimestamp(new Date(Date.UTC(2026, 8, 20, 14, 30, 0)))).toBe(
      '2026-09-20T14:30:00.000Z',
    );
  });

  it('normalises an offset instant to UTC rather than preserving the offset', () => {
    expect(toWireTimestamp(new Date('2026-09-20T16:30:00+02:00'))).toBe('2026-09-20T14:30:00.000Z');
  });

  it('produces something the wire contract accepts', () => {
    const payload = {
      signalId: 'man_01J8ZYX',
      capturedAt: toWireTimestamp(new Date()),
      sourceKey: 'signalgen-v1',
      topic: 'Trades',
      tone: 'Professional',
      platform: 'LinkedIn',
    };
    expect(dmSignalPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe('isUtcWireTimestamp', () => {
  it('accepts a Z-suffixed instant', () => {
    expect(isUtcWireTimestamp('2026-09-20T14:30:00.000Z')).toBe(true);
    expect(isUtcWireTimestamp('2026-09-20T14:30:00Z')).toBe(true);
  });

  it('rejects an offset or zoneless timestamp', () => {
    // Both are valid ISO-8601 and both are wrong for storage: one carries a
    // zone we did not choose, the other carries none at all.
    expect(isUtcWireTimestamp('2026-09-20T16:30:00+02:00')).toBe(false);
    expect(isUtcWireTimestamp('2026-09-20T14:30:00')).toBe(false);
  });
});

describe('DISPLAY_TIME_ZONE', () => {
  it('records the rendering zone for Phase 3, without applying it to the wire', () => {
    expect(DISPLAY_TIME_ZONE).toBe('America/Chicago');
    expect(toWireTimestamp(new Date())).toMatch(/Z$/);
  });
});
