import { describe, expect, it } from 'vitest';
import {
  describeLedgerResponse,
  fromDmResponse,
  fromSchemaRejection,
  fromToneRejection,
  fromTransportError,
} from '../src/dm';
import { httpResponse } from './helpers/fakes';

/**
 * architecture-spec.md §7 types `dmResponse` as Json rather than text so that
 * a contract drift is queryable across the ledger. These tests pin the shapes
 * that makes possible — every branch produces an object with a discriminating
 * key, never a bare string.
 */
describe('fromDmResponse', () => {
  it('stores DM\'s parsed body as structured JSON', () => {
    const body = {
      error: 'VALIDATION_FAILED',
      details: [{ field: 'tone', message: "Value 'Sarcastic' is not a recognized tone" }],
    };
    const stored = fromDmResponse(httpResponse(400, body) as never);

    expect(stored).toEqual(body);
    // The point of the Json column: reachable by field, not by substring.
    expect((stored as typeof body).details[0]?.field).toBe('tone');
  });

  it('keeps a non-JSON body under `raw` rather than discarding it', () => {
    // An HTML error page from a proxy in front of DM is exactly what you want
    // to be able to read back later.
    const stored = fromDmResponse({
      kind: 'response',
      status: 502,
      retryAfter: null,
      body: null,
      rawBody: '<html><body>502 Bad Gateway</body></html>',
    });
    expect(stored).toEqual({ raw: '<html><body>502 Bad Gateway</body></html>' });
  });

  it('truncates a runaway body', () => {
    const stored = fromDmResponse({
      kind: 'response',
      status: 500,
      retryAfter: null,
      body: null,
      rawBody: 'x'.repeat(5000),
    }) as { raw: string };
    expect(stored.raw.length).toBe(2000);
  });
});

describe('fromTransportError', () => {
  it('records the absence of a response as a structured error', () => {
    expect(fromTransportError('ECONNREFUSED')).toEqual({
      error: 'TRANSPORT_ERROR',
      message: 'ECONNREFUSED',
    });
  });
});

describe('fromSchemaRejection', () => {
  it('mirrors DM\'s own 400 shape, so the two read alike in the ledger', () => {
    expect(
      fromSchemaRejection([{ path: 'keywords', message: 'Too big: expected at most 20 items' }]),
    ).toEqual({
      error: 'VALIDATION_FAILED_LOCAL',
      details: [{ field: 'keywords', message: 'Too big: expected at most 20 items' }],
    });
  });
});

describe('fromToneRejection', () => {
  it('records the rejected tone and what was known at the time', () => {
    const stored = fromToneRejection('Sarcastic', ['Professional', 'Humor']);
    expect(stored).toEqual({
      error: 'TONE_REJECTED',
      details: [{ field: 'tone', message: "Value 'Sarcastic' is not a recognized tone" }],
      tone: 'Sarcastic',
      knownTones: ['Professional', 'Humor'],
    });
  });

  it('copies the tone list rather than aliasing the live taxonomy', () => {
    const live = ['Professional'];
    const stored = fromToneRejection('Sarcastic', live) as { knownTones: string[] };
    live.push('Mutated');
    expect(stored.knownTones).toEqual(['Professional']);
  });
});

describe('describeLedgerResponse', () => {
  it('renders JSON for a plain-text alert body', () => {
    expect(describeLedgerResponse({ error: 'TRANSPORT_ERROR', message: 'ETIMEDOUT' })).toBe(
      '{"error":"TRANSPORT_ERROR","message":"ETIMEDOUT"}',
    );
  });

  it('reports absence rather than printing undefined', () => {
    expect(describeLedgerResponse(undefined)).toBe('(none)');
    expect(describeLedgerResponse(null)).toBe('(none)');
  });
});
