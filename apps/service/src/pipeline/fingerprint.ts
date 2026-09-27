import { createHash } from 'node:crypto';
import type { AdapterKey } from '@signalgen/contract';

/**
 * Dedup fingerprint per architecture-spec.md §8: `sha256(adapterKey | material)`.
 *
 * The material is adapter-defined (SourceAdapter.fingerprintMaterial) because
 * what counts as "the same signal" differs by source — topic/subtopic for
 * manual entry, a canonical URL for search. The adapter key is always part of
 * the hash, so suppression windows can differ per source class and one
 * adapter's material can never suppress another's.
 */
export function fingerprintOf(adapterKey: AdapterKey, material: string): string {
  return createHash('sha256').update(`${adapterKey}|${material}`, 'utf8').digest('hex');
}
