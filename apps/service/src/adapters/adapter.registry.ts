import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { AdapterKey } from '@signalgen/contract';
import { ConfigService } from '../config';
import { RegisterAdapter, type SourceAdapter } from './source-adapter';

/**
 * Every SourceAdapter in the application, keyed by adapter key.
 *
 * Populated at boot from providers marked with @RegisterAdapter(), then
 * validated before the app accepts traffic. A misconfigured adapter fails the
 * boot rather than failing later at its first signal:
 *
 *   - no shortcode → its signalIds would carry a derived prefix nobody chose
 *   - no budget cap → ConfigService.budgetFor fails closed at 0, so it could
 *     never post, and the only symptom would be pending rows piling up
 *   - no suppression window → the pipeline could not decide dedup at all
 */
@Injectable()
export class AdapterRegistry implements OnModuleInit {
  private readonly logger = new Logger(AdapterRegistry.name);
  private readonly adapters = new Map<AdapterKey, SourceAdapter>();

  // Explicit tokens: discovery must never silently resolve to nothing, and
  // esbuild (vitest) emits no parameter-type metadata to infer them from.
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({ metadataKey: RegisterAdapter.KEY })) {
      if (wrapper.instance) this.register(wrapper.instance as SourceAdapter);
    }
    this.validate();
    const summary = [...this.adapters.values()]
      .map((a) => `${a.key} (${a.schedule ?? 'push'})`)
      .join(', ');
    this.logger.log(`Adapters registered: ${summary || 'none'}`);
  }

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.key)) {
      throw new Error(`Adapter key "${adapter.key}" is registered twice`);
    }
    this.adapters.set(adapter.key, adapter);
  }

  /** Throws listing every problem at once, so one boot surfaces them all. */
  validate(): void {
    const problems: string[] = [];
    for (const key of this.adapters.keys()) {
      if (this.config.shortcodeFor(key) === undefined) {
        problems.push(`adapter "${key}" has no shortcode in ADAPTER_SHORTCODES`);
      }
      if (!this.config.budgetedAdapterKeys.includes(key)) {
        problems.push(`adapter "${key}" has no trailing-24h budget cap`);
      }
      if (this.config.suppressionWindowMs(key) === undefined) {
        problems.push(`adapter "${key}" has no dedup suppression window`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Adapter registry is invalid:\n  - ${problems.join('\n  - ')}`);
    }
  }

  get(key: AdapterKey): SourceAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`No adapter registered for "${key}"`);
    return adapter;
  }

  all(): SourceAdapter[] {
    return [...this.adapters.values()];
  }

  /** Adapters with a cron schedule. Push-style adapters are driven externally. */
  scheduled(): SourceAdapter[] {
    return this.all().filter((adapter) => adapter.schedule !== null);
  }
}
