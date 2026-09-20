import { ulid } from 'ulid';
import type { AdapterKey } from '@signalgen/contract';

/**
 * Explicit shortcodes for the adapters the roadmap names. dm-contract.md
 * recommends a source prefix ("rdt_...", "gtr_...") so a signalId is legible
 * in DM's review queue without a lookup.
 */
const SHORTCODES: Record<string, string> = {
  manual: 'man',
  reddit: 'rdt',
};

/** dm-contract.md caps signalId at 64 characters. */
export const SIGNAL_ID_MAX_LENGTH = 64;

/**
 * Shortcode for an adapter: the explicit mapping if there is one, otherwise
 * the first three alphanumeric characters of the key. The fallback exists so
 * a new adapter cannot produce a malformed id before someone remembers to
 * register it — "calendar" derives "cal" on its own.
 */
export function shortcodeFor(adapterKey: AdapterKey): string {
  const explicit = SHORTCODES[adapterKey];
  if (explicit) return explicit;

  const derived = adapterKey.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 3);
  if (derived.length === 0) {
    throw new Error(`Cannot derive a signalId shortcode from adapterKey "${adapterKey}"`);
  }
  return derived;
}

/**
 * Builds the signalId that DM will treat as the idempotency key.
 *
 * ULID rather than UUID: lexicographically sortable by creation time, so the
 * ledger sorts naturally and a retry of the same signal is visibly the same
 * signal (architecture-spec.md §3).
 */
export function buildSignalId(adapterKey: AdapterKey, id: string = ulid()): string {
  const signalId = `${shortcodeFor(adapterKey)}_${id}`;
  if (signalId.length > SIGNAL_ID_MAX_LENGTH) {
    throw new Error(
      `Generated signalId "${signalId}" is ${signalId.length} chars; DM allows ${SIGNAL_ID_MAX_LENGTH}`,
    );
  }
  return signalId;
}
