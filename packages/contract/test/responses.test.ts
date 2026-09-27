import { describe, expect, it } from 'vitest';
import { dmResponseSchemas } from '../src/responses';
import { taxonomyResponseSchema } from '../src/taxonomy';

// Every body below is transcribed from docs/dm-contract.md.
describe('dmResponseSchemas', () => {
  it('parses the 202 ACCEPTED body', () => {
    const parsed = dmResponseSchemas.accepted.parse({
      signalId: 'sig_a1b2c3d4',
      status: 'ACCEPTED',
      matchingScheduled: true,
    });
    expect(parsed.status).toBe('ACCEPTED');
  });

  it('parses the 200 DUPLICATE body', () => {
    const parsed = dmResponseSchemas.duplicate.parse({
      signalId: 'sig_a1b2c3d4',
      status: 'DUPLICATE',
      originalCapturedAt: '2026-09-20T14:30:00Z',
    });
    expect(parsed.originalCapturedAt).toBe('2026-09-20T14:30:00Z');
  });

  it('parses the 400 VALIDATION_FAILED body', () => {
    const parsed = dmResponseSchemas.validationFailed.parse({
      error: 'VALIDATION_FAILED',
      details: [{ field: 'tone', message: "Value 'Sarcastic' is not a recognized tone" }],
    });
    expect(parsed.details[0]?.field).toBe('tone');
  });

  it('parses the 429 RATE_LIMITED body, with limit as a string', () => {
    const parsed = dmResponseSchemas.rateLimited.parse({
      error: 'RATE_LIMITED',
      limit: '10/min',
      retryAfter: 42,
    });
    expect(parsed.retryAfter).toBe(42);
  });

  it('does not confuse ACCEPTED and DUPLICATE', () => {
    expect(
      dmResponseSchemas.accepted.safeParse({
        signalId: 'x',
        status: 'DUPLICATE',
        originalCapturedAt: '2026-09-20T14:30:00Z',
      }).success,
    ).toBe(false);
  });

  it('tolerates DM adding fields to its own responses', () => {
    expect(
      dmResponseSchemas.accepted.safeParse({
        signalId: 'x',
        status: 'ACCEPTED',
        matchingScheduled: true,
        queuePosition: 3,
      }).success,
    ).toBe(true);
  });
});

describe('taxonomyResponseSchema', () => {
  // The shape DM serves live (2026-09-27): ids on categories and
  // subcategories, subcategories as objects, and no tones yet.
  const LIVE = {
    categories: [
      {
        id: 'c-trades',
        name: 'Trades',
        subcategories: [
          { id: 's-welding', name: 'Welding' },
          { id: 's-plumbing', name: 'Plumbing' },
        ],
      },
      { id: 'c-babies', name: 'Babies', subcategories: [] },
    ],
  };

  it('parses the live DM body, which has no tones yet', () => {
    const parsed = taxonomyResponseSchema.parse(LIVE);
    expect(parsed.categories.map((c) => c.name)).toEqual(['Trades', 'Babies']);
    expect(parsed.categories[0]?.subcategories.map((s) => s.name)).toEqual(['Welding', 'Plumbing']);
    expect(parsed.tones).toBeUndefined();
  });

  it('parses tones once DM publishes them', () => {
    const parsed = taxonomyResponseSchema.parse({
      ...LIVE,
      tones: ['Professional', 'Humor', 'Inspirational', 'Vintage', 'Bold'],
    });
    expect(parsed.tones).toHaveLength(5);
  });

  it('rejects the old string-subcategory shape', () => {
    expect(
      taxonomyResponseSchema.safeParse({ categories: [{ name: 'Trades', subcategories: ['Welding'] }] }).success,
    ).toBe(false);
  });

  it('rejects a body missing categories', () => {
    expect(taxonomyResponseSchema.safeParse({ tones: [] }).success).toBe(false);
  });
});
