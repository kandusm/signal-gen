import type { CandidateSignal } from '@signalgen/contract';

/**
 * Turns an adapter's CandidateSignal into the exact object posted to DM.
 *
 * Two fields are added here because the pipeline owns them, not the adapter:
 * `signalId` (the idempotency key, already persisted to the ledger) and
 * `sourceKey` (the generator identity).
 *
 * Two internal fields are removed:
 *   adapterKey       — ledger and budget concept; not a wire field.
 *   taxonomyAligned  — moved into `extensions.taxonomyAligned`, per
 *                      architecture-spec.md §5. The wire schema is strict and
 *                      has no top-level key for it, so leaving it in place
 *                      would fail validation rather than silently pass.
 *
 * Returns an untyped object on purpose: the caller validates it with
 * dmSignalPayloadSchema, and that parse is the only thing allowed to declare
 * it a valid payload.
 */
export function buildDmPayload(
  candidate: CandidateSignal,
  identity: { signalId: string; sourceKey: string },
): Record<string, unknown> {
  const { adapterKey: _adapterKey, taxonomyAligned, extensions, ...wireFields } = candidate;

  const payload: Record<string, unknown> = {
    signalId: identity.signalId,
    sourceKey: identity.sourceKey,
    ...stripUndefined(wireFields),
    extensions: { ...(extensions ?? {}), taxonomyAligned },
  };

  return payload;
}

/**
 * Drops keys whose value is `undefined`.
 *
 * JSON.stringify would drop them anyway, but they would still be visible in
 * the ledger's `payload` column and in test snapshots, where an explicit
 * `"subtopic": undefined` reads as "we tried to send this" rather than "the
 * adapter had nothing".
 */
function stripUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
