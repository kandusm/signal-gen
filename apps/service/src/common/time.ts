/**
 * Time conventions, per build-plan.md §9.
 *
 * > All storage/wire timestamps UTC ISO-8601; anything user-facing renders in
 * > America/Chicago. Codify in Phase 0.
 *
 * Three mechanisms carry the storage/wire half, so it does not rest on anyone
 * remembering:
 *
 *   - every DateTime column is `Timestamptz(3)` (prisma/schema.prisma), so the
 *     zone is recorded rather than inferred from the server's TZ;
 *   - the container runs with `TZ=UTC` (Dockerfile);
 *   - `toWireTimestamp` below is the only way this service formats a timestamp
 *     for DM, and it always emits `Z`.
 *
 * The user-facing half has nothing to render yet — Phase 0 has no UI, and
 * /healthz is an ops surface that should stay unambiguous. `DISPLAY_TIME_ZONE`
 * is recorded here so the Phase 3 web app inherits the decision instead of
 * re-making it.
 */

/** Rendering zone for any human-facing surface. Phase 3 and later. */
export const DISPLAY_TIME_ZONE = 'America/Chicago';

/**
 * Formats a timestamp for the wire and the ledger: ISO-8601, UTC, `Z`-suffixed.
 *
 * `Date.prototype.toISOString` is already UTC regardless of the process zone,
 * which is exactly the property wanted — this function exists to make that
 * choice explicit and greppable rather than incidental.
 */
export function toWireTimestamp(at: Date): string {
  return at.toISOString();
}

/** True when a string is an ISO-8601 instant in UTC (`Z`), not a local time. */
export function isUtcWireTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}
