/**
 * Retry schedule and response classification for POST /api/signals.
 * architecture-spec.md §6; restated by the Phase 0 brief.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 1m → 5m → 30m → 2h → 6h, then park as `failed`. */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  1 * MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  6 * HOUR,
];

/** One initial attempt plus one per schedule entry. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/**
 * Delay before the next attempt, given how many attempts have already been
 * made (1-based). Returns null when the schedule is exhausted.
 */
export function nextRetryDelayMs(attemptsMade: number): number | null {
  if (attemptsMade < 1) throw new Error(`attemptsMade must be >= 1, received ${attemptsMade}`);
  return RETRY_SCHEDULE_MS[attemptsMade - 1] ?? null;
}

export type DmOutcome =
  /** 202 — ingested. */
  | 'accepted'
  /** 200 DUPLICATE — DM already had this signalId. */
  | 'duplicate'
  /** Any other 2xx — DM took it, but not in a documented shape. */
  | 'accepted_undocumented'
  /** 429 — our accounting was wrong. Always alerted. */
  | 'rate_limited'
  /** Non-retryable. Our payload or our contract understanding is wrong. */
  | 'permanent'
  /** 5xx and transport errors. Retryable on the schedule. */
  | 'retryable';

/**
 * Maps an HTTP status onto a ledger decision.
 *
 * Note the treatment of 4xx: the brief names 400 and 401, while
 * architecture-spec.md §6 says "4xx (except 429) is failed_permanent
 * immediately". The spec's wider rule is used here — retrying a 403 or 404 on
 * a six-hour schedule cannot fix it, and would keep hammering DM with a
 * request we already know is malformed.
 */
export function classifyStatus(status: number): DmOutcome {
  if (status === 202) return 'accepted';
  if (status === 200) return 'duplicate';
  if (status >= 200 && status < 300) return 'accepted_undocumented';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'retryable';
  // Everything else (3xx and 4xx alike) is something we must fix, not wait out.
  return 'permanent';
}

/**
 * Seconds to wait, from a `Retry-After` header.
 *
 * RFC 9110 allows either delta-seconds or an HTTP-date; DM's documented shape
 * is delta-seconds, but a proxy in front of it may rewrite that. Returns null
 * when the header is absent or unparseable, leaving the caller to fall back to
 * the normal schedule.
 */
export function parseRetryAfterSeconds(header: string | null | undefined, now: Date = new Date()): number | null {
  if (!header) return null;

  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  const deltaSeconds = Math.ceil((asDate - now.getTime()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}
