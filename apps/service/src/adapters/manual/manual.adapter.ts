import { Injectable } from '@nestjs/common';
import type { CandidateSignal } from '@signalgen/contract';
import { RegisterAdapter, type SourceAdapter } from '../source-adapter';

/**
 * Manual entry (architecture-spec.md §9.1): push-style, no cron.
 *
 * Candidates arrive through POST /manual/signals rather than a fetch, so
 * `fetch` has nothing to pull. What this class contributes to the pipeline is
 * its identity (key, budget, shortcode, window) and its dedup material.
 */
@RegisterAdapter()
@Injectable()
export class ManualAdapter implements SourceAdapter {
  readonly key = 'manual';
  readonly schedule = null;

  async fetch(): Promise<CandidateSignal[]> {
    return [];
  }

  /** `lowercase(trim(topic)) | lowercase(trim(subtopic ?? ""))` — spec §8. */
  fingerprintMaterial(candidate: CandidateSignal): string {
    const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
    return `${normalize(candidate.topic)}|${normalize(candidate.subtopic)}`;
  }
}
