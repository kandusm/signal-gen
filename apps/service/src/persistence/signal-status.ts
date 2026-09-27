/**
 * Ledger states (architecture-spec.md §7, plus `rejected_tone` from the
 * Phase 0 brief's tone gate).
 *
 * Stored as a plain string column rather than a Postgres enum: adding a state
 * should be a code change, not a migration that locks the table.
 */
export const SignalStatus = {
  /** Written before the first network attempt. Also the over-budget parking state. */
  PENDING: 'pending',
  /** DM accepted it (202), or confirmed it already had it (200 DUPLICATE). */
  POSTED: 'posted',
  /** Dedup suppressed it. Phase 1. */
  SUPPRESSED: 'suppressed',
  /** DRY_RUN was on; passed every guard, ledgered, never sent. */
  DRY_RUN: 'dry_run',
  /** Retry schedule exhausted. */
  FAILED: 'failed',
  /** Non-retryable rejection from DM (400/401). Contract drift. */
  FAILED_PERMANENT: 'failed_permanent',
  /** Failed our own wire-schema check; never sent. */
  REJECTED_SCHEMA: 'rejected_schema',
  /** Tone not in DM's taxonomy; never sent. */
  REJECTED_TONE: 'rejected_tone',
} as const;

export type SignalStatus = (typeof SignalStatus)[keyof typeof SignalStatus];

/**
 * States that count against the trailing-24h budgets.
 *
 * `dry_run` counts as well as `posted` (Phase 1 brief §1): a dry run passes
 * every guard a real post would, so counting it makes adapter caps testable
 * without posting. Suppressed, rejected and failed rows never count.
 */
export const BUDGET_CONSUMING_STATUSES: readonly SignalStatus[] = [
  SignalStatus.POSTED,
  SignalStatus.DRY_RUN,
];

/** States the sweep may pick up and dispatch. */
export const DISPATCHABLE_STATUSES: readonly SignalStatus[] = [SignalStatus.PENDING];

/** States from which no further work happens. */
export const TERMINAL_STATUSES: readonly SignalStatus[] = [
  SignalStatus.POSTED,
  SignalStatus.SUPPRESSED,
  SignalStatus.DRY_RUN,
  SignalStatus.FAILED,
  SignalStatus.FAILED_PERMANENT,
  SignalStatus.REJECTED_SCHEMA,
  SignalStatus.REJECTED_TONE,
];
