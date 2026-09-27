import { Injectable } from '@nestjs/common';
import type { CandidateSignal, ManualSubmission } from '@signalgen/contract';
import { toWireTimestamp } from '../../common';
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

  /**
   * An operator submission as a CandidateSignal. `taxonomyAligned` is decided
   * by the caller against DM's live taxonomy (spec §5: manual entry selects
   * from it, so a mismatch is worth flagging rather than guessing).
   */
  toCandidate(submission: ManualSubmission, capturedAt: Date, taxonomyAligned: boolean): CandidateSignal {
    return {
      adapterKey: this.key,
      capturedAt: toWireTimestamp(capturedAt),
      topic: submission.topic,
      subtopic: submission.subtopic,
      tone: submission.tone,
      platform: submission.platform,
      keywords: submission.keywords,
      audience: submission.audience,
      sourceUrl: submission.sourceUrl,
      sourceExcerpt: submission.sourceExcerpt,
      signalDecayHint: submission.signalDecayHint,
      taxonomyAligned,
    };
  }

  /** `lowercase(trim(topic)) | lowercase(trim(subtopic ?? ""))` — spec §8. */
  fingerprintMaterial(candidate: CandidateSignal): string {
    const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
    return `${normalize(candidate.topic)}|${normalize(candidate.subtopic)}`;
  }
}
