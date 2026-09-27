import { ulid } from 'ulid';
import type { AdapterKey } from '@signalgen/contract';

/** dm-contract.md caps signalId at 64 characters. */
export const SIGNAL_ID_MAX_LENGTH = 64;

/**
 * Derives a shortcode from an adapter key when config has none.
 *
 * The map in ADAPTER_SHORTCODES is the real source (architecture-spec.md fixes
 * `man_` and `srch_`). This fallback exists so a new adapter cannot produce a
 * malformed id before someone remembers to register it — "calendar" derives
 * "cal" on its own.
 */
export function deriveShortcode(adapterKey: AdapterKey): string {
  const derived = adapterKey.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
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
 *
 * `shortcode` comes from the configured map; callers pass
 * `config.shortcodeFor(adapterKey)` and this falls back to a derived one.
 */
export function buildSignalId(
  adapterKey: AdapterKey,
  shortcode?: string | undefined,
  id: string = ulid(),
): string {
  const prefix = shortcode ?? deriveShortcode(adapterKey);
  const signalId = `${prefix}_${id}`;
  if (signalId.length > SIGNAL_ID_MAX_LENGTH) {
    throw new Error(
      `Generated signalId "${signalId}" is ${signalId.length} chars; DM allows ${SIGNAL_ID_MAX_LENGTH}`,
    );
  }
  return signalId;
}
