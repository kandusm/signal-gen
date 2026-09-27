import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { CandidateSignal } from '@signalgen/contract';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry, RegisterAdapter, type SourceAdapter } from '../src/adapters';
import { ConfigService } from '../src/config';
import { FakeConfigService } from './helpers/fakes';

function adapter(key: string, schedule: string | null = null): SourceAdapter {
  return {
    key,
    schedule,
    async fetch() {
      return [];
    },
    fingerprintMaterial: (c: CandidateSignal) => c.topic,
  };
}

/** Direct construction: register/validate/lookup need no discovery. */
function registry(config: FakeConfigService = new FakeConfigService()) {
  return new AdapterRegistry(config as never, null as never);
}

describe('AdapterRegistry — validation', () => {
  it('accepts adapters that have both a shortcode and a budget cap', () => {
    const r = registry();
    r.register(adapter('manual'));
    r.register(adapter('search', '0 7 * * *'));
    expect(() => r.validate()).not.toThrow();
  });

  it('rejects an adapter with no shortcode', () => {
    const r = registry(new FakeConfigService({ shortcodes: { manual: 'man' }, budgets: { manual: 50, rss: 10 } }));
    r.register(adapter('rss'));
    expect(() => r.validate()).toThrow(/"rss" has no shortcode/);
  });

  it('rejects an adapter with no budget cap', () => {
    const r = registry(new FakeConfigService({ shortcodes: { rss: 'rss' }, budgets: { manual: 50 } }));
    r.register(adapter('rss'));
    expect(() => r.validate()).toThrow(/"rss" has no trailing-24h budget cap/);
  });

  it('reports every problem in one error, so one boot surfaces them all', () => {
    const r = registry(new FakeConfigService({ shortcodes: {}, budgets: {} }));
    r.register(adapter('rss'));
    r.register(adapter('atom'));
    const error = (() => {
      try {
        r.validate();
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(error.match(/^ {2}- /gm)).toHaveLength(4);
  });

  it('refuses a key registered twice', () => {
    const r = registry();
    r.register(adapter('manual'));
    expect(() => r.register(adapter('manual'))).toThrow(/registered twice/);
  });
});

describe('AdapterRegistry — lookup', () => {
  it('finds an adapter by key and fails loudly on an unknown one', () => {
    const r = registry();
    const manual = adapter('manual');
    r.register(manual);
    expect(r.get('manual')).toBe(manual);
    expect(() => r.get('rss')).toThrow(/No adapter registered for "rss"/);
  });

  it('separates scheduled adapters from push-style ones', () => {
    const r = registry();
    r.register(adapter('manual'));
    r.register(adapter('search', '0 7 * * *'));
    expect(r.scheduled().map((a) => a.key)).toEqual(['search']);
    expect(r.all().map((a) => a.key)).toEqual(['manual', 'search']);
  });
});

@RegisterAdapter()
@Injectable()
class DiscoveredAdapter implements SourceAdapter {
  readonly key = 'manual';
  readonly schedule = null;
  async fetch() {
    return [];
  }
  fingerprintMaterial(c: CandidateSignal) {
    return c.topic;
  }
}

@RegisterAdapter()
@Injectable()
class UnconfiguredAdapter extends DiscoveredAdapter {
  override readonly key = 'rss';
}

/** Nothing registers itself here: an ordinary provider is not an adapter. */
@Injectable()
class UnrelatedProvider {}

describe('AdapterRegistry — discovery at boot', () => {
  async function boot(providers: unknown[]) {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        AdapterRegistry,
        { provide: ConfigService, useValue: new FakeConfigService() },
        ...(providers as never[]),
      ],
    }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  it('registers providers marked with @RegisterAdapter and nothing else', async () => {
    const moduleRef = await boot([DiscoveredAdapter, UnrelatedProvider]);
    expect(moduleRef.get(AdapterRegistry).all().map((a) => a.key)).toEqual(['manual']);
    await moduleRef.close();
  });

  it('fails the boot when a registered adapter is misconfigured', async () => {
    await expect(boot([UnconfiguredAdapter])).rejects.toThrow(/"rss" has no shortcode/);
  });
});
