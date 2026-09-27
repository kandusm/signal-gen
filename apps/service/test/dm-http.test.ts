import { afterEach, describe, expect, it, vi } from 'vitest';
import { DmHttpClient, RAW_BODY_MAX_LENGTH } from '../src/dm';

/**
 * DmHttpClient against a stubbed global fetch. Nothing here leaves the
 * process; the stub stands in for DM.
 */
const config = {
  get(key: string) {
    return ({ DM_BASE_URL: 'https://dm.test', DM_SIGNAL_KEY: 'test-key' } as Record<string, string>)[key];
  },
};

function stubFetch(body: string, status = 200) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DmHttpClient — response bodies', () => {
  it('parses a JSON body longer than the ledger truncation limit', async () => {
    // Regression: the body was truncated before parsing, so DM's real ~2.7 KB
    // taxonomy response parsed as null and the tone gate never had data.
    const categories = Array.from({ length: 40 }, (_, i) => ({
      id: `id-${i}`,
      name: `Category ${i}`,
      subcategories: [{ id: `sub-${i}`, name: `Subcategory ${i}` }],
    }));
    const text = JSON.stringify({ categories });
    expect(text.length).toBeGreaterThan(RAW_BODY_MAX_LENGTH);
    stubFetch(text);

    const result = await new DmHttpClient(config as never).getTaxonomy();

    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.body).toEqual({ categories });
    expect(result.rawBody).toHaveLength(RAW_BODY_MAX_LENGTH);
  });

  it('still truncates the raw copy kept for the ledger', async () => {
    stubFetch(`<html>${'x'.repeat(5000)}</html>`, 502);

    const result = await new DmHttpClient(config as never).getTaxonomy();

    if (result.kind !== 'response') throw new Error('expected a response');
    expect(result.body).toBeNull();
    expect(result.rawBody).toHaveLength(RAW_BODY_MAX_LENGTH);
  });

  it('sends the contract bearer header', async () => {
    const fetchMock = stubFetch('{}');

    await new DmHttpClient(config as never).getTaxonomy();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dm.test/api/secondarydesigns/categories');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });
});
