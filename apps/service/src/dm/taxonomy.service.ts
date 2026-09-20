import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { type TaxonomyResponse, taxonomyResponseSchema } from '@signalgen/contract';
import { CLOCK, type Clock, systemClock } from '../common';
import { TaxonomySnapshotRepository } from '../persistence';
import { DmHttpClient } from './dm.http';

/** architecture-spec.md §5: 6-hour TTL. */
export const TAXONOMY_TTL_MS = 6 * 60 * 60 * 1000;

export interface TaxonomyState {
  taxonomy: TaxonomyResponse;
  fetchedAt: Date;
  /** True when this came from the DB because DM could not be reached. */
  fromSnapshot: boolean;
}

/**
 * DM's taxonomy, cached in memory with a persisted fallback.
 *
 * Three layers, in order of preference: a fresh in-memory copy, a re-fetch
 * from DM, and the most recent TaxonomySnapshot row. The third exists so that
 * DM being down at boot degrades to stale taxonomy rather than none — losing
 * Tier 1 match quality is survivable, rejecting every signal is not.
 */
@Injectable()
export class TaxonomyService implements OnModuleInit {
  private readonly logger = new Logger(TaxonomyService.name);
  private state: TaxonomyState | null = null;

  constructor(
    private readonly http: DmHttpClient,
    private readonly snapshots: TaxonomySnapshotRepository,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /**
   * Warms the cache at boot. Deliberately does not throw: DM being unreachable
   * at startup must not stop the service from booting, because /healthz is how
   * anyone would find out that it is unreachable.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.get();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Taxonomy unavailable at boot (continuing): ${reason}`);
    }
  }

  /** Current taxonomy, refreshing if the cached copy has aged past the TTL. */
  async get(): Promise<TaxonomyState | null> {
    if (this.state && !this.isStale(this.state)) return this.state;

    const refreshed = await this.refresh();
    if (refreshed) return refreshed;

    // Refresh failed. A stale in-memory copy still beats nothing.
    if (this.state) {
      this.logger.warn('Serving stale in-memory taxonomy; DM refresh failed');
      return this.state;
    }

    return this.loadSnapshot();
  }

  /** Fetches from DM and persists a snapshot. Returns null on any failure. */
  async refresh(): Promise<TaxonomyState | null> {
    const result = await this.http.getTaxonomy();

    if (result.kind === 'transport_error') {
      this.logger.warn(`Taxonomy fetch failed: ${result.message}`);
      return null;
    }
    if (result.status !== 200) {
      this.logger.warn(`Taxonomy fetch returned HTTP ${result.status}`);
      return null;
    }

    const parsed = taxonomyResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      // DM answered with something we do not recognise. Treated as a failed
      // refresh so the snapshot fallback applies, rather than replacing good
      // taxonomy with a shape we cannot use.
      this.logger.error(`Taxonomy response did not match the contract: ${parsed.error.message}`);
      return null;
    }

    const fetchedAt = this.now();
    this.state = { taxonomy: parsed.data, fetchedAt, fromSnapshot: false };

    try {
      await this.snapshots.create(parsed.data as never, fetchedAt);
    } catch (error) {
      // The live copy is already cached; a failed snapshot write only costs us
      // the fallback on the next cold boot.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to persist taxonomy snapshot: ${reason}`);
    }

    this.logger.log(
      `Taxonomy refreshed: ${parsed.data.categories.length} categories, ${parsed.data.tones.length} tones`,
    );
    return this.state;
  }

  /**
   * Whether a tone is in DM's taxonomy.
   *
   * Returns `unknown` when we have no taxonomy at all. That case must not be
   * treated as invalid: dm-contract.md says an unrecognised tone still matches
   * via Tier 2 and Tier 3, so rejecting every signal because DM was down at
   * boot would trade a small quality loss for a total outage.
   *
   * Comparison is exact. Adapters are expected to emit taxonomy values
   * verbatim, and catching a casing drift here — before DM does — is the
   * entire point of the gate.
   */
  async isValidTone(tone: string): Promise<boolean | 'unknown'> {
    const state = await this.get();
    if (!state) return 'unknown';
    return state.taxonomy.tones.includes(tone);
  }

  /** Whether topic/subtopic map onto a Category/Subcategory pair. */
  async isAlignedCategory(topic: string, subtopic?: string): Promise<boolean> {
    const state = await this.get();
    if (!state) return false;

    const category = state.taxonomy.categories.find((c) => c.name === topic);
    if (!category) return false;
    if (subtopic === undefined) return true;
    return category.subcategories.includes(subtopic);
  }

  /** Cached state without triggering a fetch — for /healthz. */
  peek(): TaxonomyState | null {
    return this.state;
  }

  /** Age of the cached taxonomy in milliseconds, or null if there is none. */
  ageMs(): number | null {
    if (!this.state) return null;
    return this.now().getTime() - this.state.fetchedAt.getTime();
  }

  private isStale(state: TaxonomyState): boolean {
    return this.now().getTime() - state.fetchedAt.getTime() >= TAXONOMY_TTL_MS;
  }

  private async loadSnapshot(): Promise<TaxonomyState | null> {
    let row: Awaited<ReturnType<TaxonomySnapshotRepository['findLatest']>>;
    try {
      row = await this.snapshots.findLatest();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not read taxonomy snapshot: ${reason}`);
      return null;
    }
    if (!row) {
      this.logger.error('No taxonomy available: DM unreachable and no snapshot persisted');
      return null;
    }

    const parsed = taxonomyResponseSchema.safeParse(row.body);
    if (!parsed.success) {
      this.logger.error('Persisted taxonomy snapshot does not match the contract');
      return null;
    }

    this.logger.warn(`Falling back to taxonomy snapshot from ${row.fetchedAt.toISOString()}`);
    this.state = { taxonomy: parsed.data, fetchedAt: row.fetchedAt, fromSnapshot: true };
    return this.state;
  }
}
