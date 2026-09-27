import { Injectable } from '@nestjs/common';
import type { AdapterKey } from '@signalgen/contract';
import type { Env } from './config.schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Typed, read-only access to validated configuration. */
@Injectable()
export class ConfigService {
  constructor(private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get dryRun(): boolean {
    return this.env.DRY_RUN;
  }

  get generatorSourceKey(): string {
    return this.env.GENERATOR_SOURCE_KEY;
  }

  get totalBudget24h(): number {
    return this.env.BUDGET_TOTAL_24H;
  }

  /**
   * Trailing-24h cap for one adapter.
   *
   * Phase 0 ships budgets for the two adapters the brief names. An unknown
   * adapter gets 0 — it cannot post until someone adds its budget variable.
   * Failing closed is the right default for a rate contract: the cost of a
   * blocked adapter is a visible pending row, the cost of an unbudgeted one is
   * a 429 storm against DM.
   */
  budgetFor(adapterKey: AdapterKey): number {
    switch (adapterKey) {
      case 'manual':
        return this.env.BUDGET_MANUAL_24H;
      case 'search':
        return this.env.BUDGET_SEARCH_24H;
      default:
        return 0;
    }
  }

  /**
   * How long a claimed fingerprint suppresses repeats, or undefined for an
   * adapter with no configured window. AdapterRegistry refuses to boot with
   * such an adapter, so the pipeline never has to guess one.
   */
  suppressionWindowMs(adapterKey: AdapterKey): number | undefined {
    const days = (() => {
      switch (adapterKey) {
        case 'manual':
          return this.env.SUPPRESS_MANUAL_DAYS;
        case 'search':
          return this.env.SUPPRESS_SEARCH_DAYS;
        default:
          return undefined;
      }
    })();
    return days === undefined ? undefined : days * DAY_MS;
  }

  /** Adapters that have a configured budget, for /healthz reporting. */
  get budgetedAdapterKeys(): string[] {
    return ['manual', 'search'];
  }

  /**
   * Shortcode for an adapter's signalId prefix, or undefined if none is
   * configured. signal-id.ts derives a fallback rather than failing, so an
   * unregistered adapter still produces a well-formed id.
   */
  shortcodeFor(adapterKey: AdapterKey): string | undefined {
    return this.env.ADAPTER_SHORTCODES[adapterKey];
  }
}
