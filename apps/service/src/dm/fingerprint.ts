import { createHash } from 'node:crypto';
import type { CandidateSignal } from '@signalgen/contract';

/**
 * Dedup fingerprint per architecture-spec.md §8.
 *
 * The spec writes this as `sha256(sourceKey | topic | subtopic)`, where
 * "sourceKey" meant the per-adapter key. The Phase 0 brief reassigns
 * `sourceKey` to the generator identity (one constant value per deployment),
 * which would collapse every adapter into one fingerprint space. `adapterKey`
 * is what the spec actually meant — §8's suppression windows are defined per
 * source class (reddit 21 days, manual 7 days), which only works if the
 * adapter is part of the hash.
 *
 * Phase 0 records this value; the suppression logic that reads it is Phase 1.
 */
export function fingerprintFor(candidate: Pick<CandidateSignal, 'adapterKey' | 'topic' | 'subtopic'>): string {
  const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
  const material = [candidate.adapterKey, normalize(candidate.topic), normalize(candidate.subtopic)].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
