import { describe, expect, it } from 'vitest';
import { manualSubmissionSchema } from '../src';

describe('manualSubmissionSchema', () => {
  it('requires only topic and tone, and fills the defaults', () => {
    expect(manualSubmissionSchema.parse({ topic: 'Trades', tone: 'Professional' })).toEqual({
      topic: 'Trades',
      tone: 'Professional',
      platform: 'Manual',
      signalDecayHint: 'SHORT',
    });
  });

  it('keeps subtopic optional (binding clarification, 2026-09-27)', () => {
    expect(manualSubmissionSchema.safeParse({ topic: 'T', tone: 'X' }).success).toBe(true);
    expect(manualSubmissionSchema.safeParse({ topic: 'T', tone: 'X', subtopic: 'S' }).success).toBe(true);
  });

  it.each([
    ['missing topic', { tone: 'X' }],
    ['missing tone', { topic: 'T' }],
    ['blank topic', { topic: '   ', tone: 'X' }],
    ['21 keywords', { topic: 'T', tone: 'X', keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }],
    ['501-char excerpt', { topic: 'T', tone: 'X', sourceExcerpt: 'x'.repeat(501) }],
    ['bad sourceUrl', { topic: 'T', tone: 'X', sourceUrl: 'not a url' }],
    ['unknown decay hint', { topic: 'T', tone: 'X', signalDecayHint: 'LATER' }],
    ['unknown key', { topic: 'T', tone: 'X', sourceKey: 'mine' }],
  ])('rejects %s', (_label, body) => {
    expect(manualSubmissionSchema.safeParse(body).success).toBe(false);
  });

  it('trims operator input', () => {
    expect(manualSubmissionSchema.parse({ topic: '  Trades ', tone: ' Professional ' })).toMatchObject({
      topic: 'Trades',
      tone: 'Professional',
    });
  });
});
