/**
 * Operational alerts (architecture-spec.md §10).
 *
 * Every alert carries `signalId` and the ledger `status` it was written with,
 * because the first thing anyone does on receiving one is open the ledger row.
 * The two run-level alerts have no signal, and say so explicitly.
 */
export type Alert =
  | {
      kind: 'permanent_failure';
      signalId: string;
      status: string;
      adapterKey: string;
      dmStatusCode: number;
      dmResponse: string | undefined;
    }
  | {
      kind: 'retry_exhaustion';
      signalId: string;
      status: string;
      adapterKey: string;
      attempts: number;
      lastError: string | undefined;
    }
  | {
      kind: 'rate_limited';
      signalId: string;
      status: string;
      adapterKey: string;
      retryAfterSeconds: number | null;
      usageTotal: number;
      usageForAdapter: number;
    }
  | {
      kind: 'tone_rejection';
      signalId: string;
      status: string;
      adapterKey: string;
      tone: string;
      knownTones: string[];
    }
  | {
      kind: 'adapter_run_failure';
      adapterKey: string;
      consecutiveFailures: number;
      error: string;
    };

export type AlertKind = Alert['kind'];
