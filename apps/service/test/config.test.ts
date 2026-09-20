import { describe, expect, it } from 'vitest';
import { ConfigService, loadEnv } from '../src/config';

/** A complete, valid environment; individual tests override one key at a time. */
const VALID = {
  DATABASE_URL: 'postgresql://signalgen:signalgen@localhost:5432/signalgen',
  DIRECT_URL: 'postgresql://signalgen:signalgen@localhost:5432/signalgen',
  DM_BASE_URL: 'https://sartorial.commvergent.com',
  DM_SIGNAL_KEY: 'dm-key',
  MANUAL_API_TOKEN: 'manual-token',
  MAILWAIN_BASE_URL: 'https://mail-wain.fly.dev',
  MAILWAIN_API_KEY: 'mailwain-key',
  ALERT_FROM: 'signalgen@notifications.commvergent.com',
  ALERT_TO: 'kmacmillan@commvergent.com',
} as const;

describe('loadEnv — defaults', () => {
  it('applies every documented default', () => {
    const env = loadEnv({ ...VALID } as never);

    expect(env.GENERATOR_SOURCE_KEY).toBe('signalgen-v1');
    expect(env.BUDGET_TOTAL_24H).toBe(500);
    expect(env.BUDGET_MANUAL_24H).toBe(50);
    expect(env.BUDGET_SEARCH_24H).toBe(100);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('defaults DRY_RUN to true, so a missing variable cannot cause a real post', () => {
    expect(loadEnv({ ...VALID } as never).DRY_RUN).toBe(true);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['  True  ', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
  ])('parses DRY_RUN=%s as %s', (raw, expected) => {
    expect(loadEnv({ ...VALID, DRY_RUN: raw } as never).DRY_RUN).toBe(expected);
  });

  it('rejects an ambiguous DRY_RUN rather than guessing', () => {
    // "yes" silently falling through to false would be the worst possible
    // outcome for this particular variable.
    expect(() => loadEnv({ ...VALID, DRY_RUN: 'yes' } as never)).toThrow(/DRY_RUN/);
  });
});

describe('loadEnv — validation', () => {
  it('reports every problem at once', () => {
    let message = '';
    try {
      loadEnv({ ...VALID, DM_BASE_URL: 'not-a-url', ALERT_TO: 'not-an-email' } as never);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DM_BASE_URL');
    expect(message).toContain('ALERT_TO');
  });

  it.each(Object.keys(VALID))('fails fast when %s is missing', (key) => {
    const incomplete: Record<string, string> = { ...VALID };
    delete incomplete[key];
    expect(() => loadEnv(incomplete as never)).toThrow(new RegExp(key));
  });

  it('rejects a GENERATOR_SOURCE_KEY longer than dm-contract.md allows', () => {
    // sourceKey is capped at 32 chars on the wire. Catching it at boot beats
    // catching it as a 400 on the first real post.
    expect(() => loadEnv({ ...VALID, GENERATOR_SOURCE_KEY: 'a'.repeat(33) } as never)).toThrow(
      /GENERATOR_SOURCE_KEY/,
    );
    expect(loadEnv({ ...VALID, GENERATOR_SOURCE_KEY: 'a'.repeat(32) } as never).GENERATOR_SOURCE_KEY)
      .toHaveLength(32);
  });

  it('strips trailing slashes from base URLs', () => {
    const env = loadEnv({ ...VALID, DM_BASE_URL: 'https://sartorial.commvergent.com///' } as never);
    expect(env.DM_BASE_URL).toBe('https://sartorial.commvergent.com');
  });

  it('parses a comma-separated ALERT_TO into a list', () => {
    const env = loadEnv({
      ...VALID,
      ALERT_TO: 'kmacmillan@commvergent.com, chris@commvergent.com',
    } as never);
    expect(env.ALERT_TO).toEqual(['kmacmillan@commvergent.com', 'chris@commvergent.com']);
  });

  it('rejects ALERT_TO when any entry is not an address', () => {
    expect(() =>
      loadEnv({ ...VALID, ALERT_TO: 'kmacmillan@commvergent.com, nope' } as never),
    ).toThrow(/ALERT_TO/);
  });

  it('rejects a negative budget', () => {
    expect(() => loadEnv({ ...VALID, BUDGET_TOTAL_24H: '-1' } as never)).toThrow(/BUDGET_TOTAL_24H/);
  });

  it('accepts a budget of zero, which disables an adapter', () => {
    expect(loadEnv({ ...VALID, BUDGET_SEARCH_24H: '0' } as never).BUDGET_SEARCH_24H).toBe(0);
  });
});

describe('loadEnv — ADAPTER_SHORTCODES', () => {
  it('defaults to the convention in architecture-spec.md', () => {
    expect(loadEnv({ ...VALID } as never).ADAPTER_SHORTCODES).toEqual({
      manual: 'man',
      search: 'srch',
    });
  });

  it('accepts an override, so a new adapter needs no code change', () => {
    const env = loadEnv({
      ...VALID,
      ADAPTER_SHORTCODES: 'manual:man, search:srch, calendar:cal',
    } as never);
    expect(env.ADAPTER_SHORTCODES['calendar']).toBe('cal');
  });

  it('rejects a malformed pair', () => {
    expect(() => loadEnv({ ...VALID, ADAPTER_SHORTCODES: 'manual' } as never)).toThrow(
      /ADAPTER_SHORTCODES/,
    );
  });

  it('rejects a shortcode that would make an illegible or oversized prefix', () => {
    expect(() => loadEnv({ ...VALID, ADAPTER_SHORTCODES: 'manual:MAN' } as never)).toThrow(
      /ADAPTER_SHORTCODES/,
    );
    expect(() =>
      loadEnv({ ...VALID, ADAPTER_SHORTCODES: 'manual:waytoolongcode' } as never),
    ).toThrow(/ADAPTER_SHORTCODES/);
  });
});

describe('ConfigService', () => {
  const service = new ConfigService(loadEnv({ ...VALID, DRY_RUN: 'false' } as never));

  it('exposes the per-adapter budgets', () => {
    expect(service.budgetFor('manual')).toBe(50);
    expect(service.budgetFor('search')).toBe(100);
  });

  it('fails closed for an adapter with no configured budget', () => {
    // A future adapter must not inherit someone else's quota by accident.
    expect(service.budgetFor('calendar')).toBe(0);
  });

  it('maps the configured adapter shortcodes', () => {
    expect(service.shortcodeFor('manual')).toBe('man');
    expect(service.shortcodeFor('search')).toBe('srch');
  });

  it('returns undefined for an unregistered adapter, so signal-id derives one', () => {
    expect(service.shortcodeFor('calendar')).toBeUndefined();
  });

  it('reports the dry-run flag and generator identity', () => {
    expect(service.dryRun).toBe(false);
    expect(service.generatorSourceKey).toBe('signalgen-v1');
    expect(service.totalBudget24h).toBe(500);
  });
});
