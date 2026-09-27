import type { Alert } from './alert.types';

export interface RenderedAlert {
  subject: string;
  text: string;
}

const SUBJECT_PREFIX = '[signalgen]';

/**
 * Plain text at heart. These are operational alerts read on a phone at an
 * inconvenient hour; the useful content is the signalId and the ledger status,
 * and both should survive any mail client. MailWain requires an html (or
 * template) body, so the same text also goes out as a <pre> block — see
 * renderAlertHtml.
 */
export function renderAlert(alert: Alert): RenderedAlert {
  switch (alert.kind) {
    case 'permanent_failure':
      return {
        subject: `${SUBJECT_PREFIX} Permanent failure posting ${alert.signalId} (HTTP ${alert.dmStatusCode})`,
        text: lines(
          'DM rejected a signal in a way that retrying cannot fix.',
          'This usually means our payload or our reading of the contract has drifted.',
          '',
          field('signalId', alert.signalId),
          field('ledger status', alert.status),
          field('adapter', alert.adapterKey),
          field('DM status code', alert.dmStatusCode),
          field('DM response', alert.dmResponse ?? '(none)'),
          '',
          'Next step: compare the ledger row\'s payload against docs/dm-contract.md.',
        ),
      };

    case 'retry_exhaustion':
      return {
        subject: `${SUBJECT_PREFIX} Retry schedule exhausted for ${alert.signalId}`,
        text: lines(
          'A signal failed every attempt on the retry schedule and has been parked.',
          '',
          field('signalId', alert.signalId),
          field('ledger status', alert.status),
          field('adapter', alert.adapterKey),
          field('attempts', alert.attempts),
          field('last error', alert.lastError ?? '(none recorded)'),
          '',
          'Next step: check DM availability, then replay the row once it is healthy.',
        ),
      };

    case 'rate_limited':
      return {
        subject: `${SUBJECT_PREFIX} DM returned 429 for ${alert.signalId}`,
        text: lines(
          'DM rate-limited us. Client-side accounting is supposed to make this',
          'impossible, so a 429 is an accounting bug rather than a normal event',
          '(architecture-spec.md §6).',
          '',
          field('signalId', alert.signalId),
          field('ledger status', alert.status),
          field('adapter', alert.adapterKey),
          field('Retry-After (s)', alert.retryAfterSeconds ?? '(absent)'),
          field('trailing 24h total', alert.usageTotal),
          field(`trailing 24h for ${alert.adapterKey}`, alert.usageForAdapter),
          '',
          'Next step: reconcile our counts against DM\'s window semantics (OQ-3).',
        ),
      };

    case 'tone_rejection':
      return {
        subject: `${SUBJECT_PREFIX} Tone rejected for adapter ${alert.adapterKey}`,
        text: lines(
          'A candidate carried a tone that is not in DM\'s taxonomy, so it was',
          'rejected before dispatch. First occurrence for this adapter today.',
          '',
          field('signalId', alert.signalId),
          field('ledger status', alert.status),
          field('adapter', alert.adapterKey),
          field('rejected tone', alert.tone),
          field('known tones', alert.knownTones.join(', ') || '(taxonomy empty)'),
          '',
          'Next step: either the adapter\'s mapping is stale or DM changed its',
          'taxonomy. Refresh the taxonomy cache and compare.',
        ),
      };

    case 'adapter_run_failure':
      return {
        subject: `${SUBJECT_PREFIX} Adapter ${alert.adapterKey} failed ${alert.consecutiveFailures} runs in a row`,
        text: lines(
          'An adapter has failed consecutive runs and is no longer producing signals.',
          '',
          field('adapter', alert.adapterKey),
          field('signalId', '(not applicable — run-level failure)'),
          field('ledger status', '(not applicable — run-level failure)'),
          field('consecutive failures', alert.consecutiveFailures),
          field('error', alert.error),
        ),
      };
  }
}

function field(label: string, value: string | number): string {
  return `${label.padEnd(22)}: ${value}`;
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

/**
 * The html part MailWain requires: the plain-text alert, escaped, in a <pre>
 * so line breaks and alignment survive. Deliberately no styling or layout —
 * the text is the alert; this is only its envelope.
 */
export function renderAlertHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<pre style="font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap;">${escaped}</pre>`;
}
