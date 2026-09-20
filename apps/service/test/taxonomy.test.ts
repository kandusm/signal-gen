import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/common';
import { TAXONOMY_TTL_MS, TaxonomyService } from '../src/dm';
import { FakeDmHttpClient, FakeTaxonomySnapshotRepository, httpResponse, transportError } from './helpers/fakes';

const NOW = new Date('2026-09-20T12:00:00.000Z');

/** The taxonomy body documented in dm-contract.md. */
const TAXONOMY = {
  categories: [
    { name: 'Trades', subcategories: ['Welding', 'Plumbing', 'Electrical', 'Carpentry'] },
  ],
  tones: ['Professional', 'Humor', 'Inspirational', 'Vintage', 'Bold'],
};

function setup() {
  const clock = fixedClock(NOW);
  const http = new FakeDmHttpClient([]);
  const snapshots = new FakeTaxonomySnapshotRepository();
  const taxonomy = new TaxonomyService(http as never, snapshots as never, clock);
  return { clock, http, snapshots, taxonomy };
}

describe('TaxonomyService — fetching and caching', () => {
  it('fetches from DM and persists a snapshot', async () => {
    const { http, snapshots, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));

    const state = await taxonomy.get();

    expect(state?.taxonomy.tones).toEqual(TAXONOMY.tones);
    expect(state?.fromSnapshot).toBe(false);
    expect(snapshots.snapshots).toHaveLength(1);
    expect(snapshots.snapshots[0]?.fetchedAt).toEqual(NOW);
  });

  it('serves the cache without re-fetching inside the TTL', async () => {
    const { clock, http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));

    await taxonomy.get();
    clock.advance(TAXONOMY_TTL_MS - 1);
    await taxonomy.get();

    expect(http.taxonomyCalls).toHaveLength(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const { clock, http, taxonomy } = setup();
    const widened = { ...TAXONOMY, tones: [...TAXONOMY.tones, 'Sarcastic'] };
    http.queueTaxonomy(httpResponse(200, TAXONOMY), httpResponse(200, widened));

    await taxonomy.get();
    clock.advance(TAXONOMY_TTL_MS);
    const refreshed = await taxonomy.get();

    expect(http.taxonomyCalls).toHaveLength(2);
    expect(refreshed?.taxonomy.tones).toContain('Sarcastic');
    expect(refreshed?.fetchedAt).toEqual(new Date(NOW.getTime() + TAXONOMY_TTL_MS));
  });

  it('keeps serving the stale in-memory copy when a refresh fails', async () => {
    const { clock, http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY), transportError('ETIMEDOUT'));

    await taxonomy.get();
    clock.advance(TAXONOMY_TTL_MS);
    const state = await taxonomy.get();

    // Stale taxonomy still answers isValidTone correctly; no taxonomy would not.
    expect(state?.taxonomy.tones).toEqual(TAXONOMY.tones);
    expect(state?.fetchedAt).toEqual(NOW);
  });

  it('does not replace good taxonomy with an unparseable response', async () => {
    const { clock, http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY), httpResponse(200, { categories: [] }));

    await taxonomy.get();
    clock.advance(TAXONOMY_TTL_MS);
    const state = await taxonomy.get();

    expect(state?.taxonomy.tones).toEqual(TAXONOMY.tones);
  });

  it('treats a non-200 as a failed refresh', async () => {
    const { http, snapshots, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(503, null));

    expect(await taxonomy.get()).toBeNull();
    expect(snapshots.snapshots).toHaveLength(0);
  });
});

describe('TaxonomyService — snapshot fallback', () => {
  it('falls back to the persisted snapshot when DM is unreachable at boot', async () => {
    const { http, snapshots, taxonomy } = setup();
    const snapshotTime = new Date(NOW.getTime() - 48 * 3_600_000);
    await snapshots.create(TAXONOMY, snapshotTime);
    http.queueTaxonomy(transportError('ECONNREFUSED'));

    const state = await taxonomy.get();

    expect(state?.fromSnapshot).toBe(true);
    expect(state?.fetchedAt).toEqual(snapshotTime);
    expect(state?.taxonomy.tones).toEqual(TAXONOMY.tones);
  });

  it('picks the most recent snapshot', async () => {
    const { http, snapshots, taxonomy } = setup();
    await snapshots.create({ ...TAXONOMY, tones: ['Old'] }, new Date(NOW.getTime() - 72 * 3_600_000));
    await snapshots.create({ ...TAXONOMY, tones: ['Newer'] }, new Date(NOW.getTime() - 12 * 3_600_000));
    http.queueTaxonomy(transportError('ECONNREFUSED'));

    expect((await taxonomy.get())?.taxonomy.tones).toEqual(['Newer']);
  });

  it('returns null when DM is unreachable and nothing was ever persisted', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(transportError('ECONNREFUSED'));

    expect(await taxonomy.get()).toBeNull();
  });

  it('survives an unreadable snapshot table', async () => {
    const { http, snapshots, taxonomy } = setup();
    snapshots.failReads = true;
    http.queueTaxonomy(transportError('ECONNREFUSED'));

    expect(await taxonomy.get()).toBeNull();
  });

  it('does not throw at boot when DM is down', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(transportError('ECONNREFUSED'));

    // /healthz is how anyone finds out DM is unreachable, so the service has
    // to finish booting in order to report it.
    await expect(taxonomy.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('TaxonomyService — isValidTone', () => {
  it('accepts a tone in the taxonomy', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isValidTone('Professional')).toBe(true);
  });

  it('rejects a tone outside the taxonomy', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isValidTone('Sarcastic')).toBe(false);
  });

  it('matches exactly, so a casing drift is caught here rather than by DM', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isValidTone('professional')).toBe(false);
  });

  it('reports unknown rather than invalid when there is no taxonomy', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(transportError('ECONNREFUSED'));
    expect(await taxonomy.isValidTone('Professional')).toBe('unknown');
  });
});

describe('TaxonomyService — isAlignedCategory', () => {
  it('aligns a known category', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isAlignedCategory('Trades')).toBe(true);
  });

  it('aligns a known category and subcategory', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isAlignedCategory('Trades', 'Welding')).toBe(true);
  });

  it('does not align a subcategory from the wrong category', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isAlignedCategory('Trades', 'Knitting')).toBe(false);
  });

  it('does not align an unknown category', async () => {
    const { http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    expect(await taxonomy.isAlignedCategory('Pipe Welding')).toBe(false);
  });
});

describe('TaxonomyService — health reporting', () => {
  it('peek does not trigger a fetch', async () => {
    const { http, taxonomy } = setup();
    expect(taxonomy.peek()).toBeNull();
    expect(http.taxonomyCalls).toHaveLength(0);
  });

  it('reports the cache age', async () => {
    const { clock, http, taxonomy } = setup();
    http.queueTaxonomy(httpResponse(200, TAXONOMY));
    await taxonomy.get();

    clock.advance(3_600_000);
    expect(taxonomy.ageMs()).toBe(3_600_000);
  });
});
