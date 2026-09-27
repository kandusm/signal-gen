import { DiscoveryService } from '@nestjs/core';
import type { AdapterKey, CandidateSignal } from '@signalgen/contract';

/** What one adapter invocation knows about itself. */
export interface RunContext {
  adapterKey: AdapterKey;
  startedAt: Date;
  /** `schedule`: a cron tick. `push`: an external submission (manual). */
  trigger: 'schedule' | 'push';
}

/**
 * A signal source (architecture-spec.md §5).
 *
 * Adapters fetch and normalise. They do not post, dedup or rate-limit — the
 * pipeline owns everything after a CandidateSignal exists.
 */
export interface SourceAdapter {
  /**
   * Internal adapter key ("manual", "search"): ledger, fingerprints, budget
   * caps. NOT the wire sourceKey, which identifies the generator instance and
   * is the same constant for every signal.
   */
  readonly key: AdapterKey;
  /** Cron expression; null for push-style adapters (manual). */
  readonly schedule: string | null;
  /** Fetch and normalise. The adapter owns auth, query semantics and mapping. */
  fetch(ctx: RunContext): Promise<CandidateSignal[]>;
  /**
   * The adapter-defined half of the dedup fingerprint (spec §8). The pipeline
   * hashes `adapterKey | fingerprintMaterial(c)`, so material only has to be
   * unique within one adapter.
   */
  fingerprintMaterial(candidate: CandidateSignal): string;
}

/**
 * Marks a provider as a SourceAdapter so AdapterRegistry finds it at boot.
 *
 * Adding a source is then a new directory under src/adapters/, this decorator
 * on the adapter class, and one module import — nothing in the pipeline
 * changes.
 */
export const RegisterAdapter = DiscoveryService.createDecorator<void>();
