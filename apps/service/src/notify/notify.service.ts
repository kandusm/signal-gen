import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock, systemClock } from '../common';
import { ConfigService } from '../config';
import { AlertThrottle } from './alert-throttle';
import { renderAlert, renderAlertHtml } from './alert.templates';
import type { Alert } from './alert.types';

/** MailWain's send endpoint (mail-wain docs/integration-guide.md §3). */
const SEND_PATH = '/v1/send';
const SEND_TIMEOUT_MS = 10_000;

/** How far back /healthz looks for failed alert deliveries. */
export const ALERT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MailWainSendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  /**
   * MailWain's /v1/send requires exactly one of `html` or `template`. Sending
   * `text` alone is a 400 — which is how every alert failed silently until
   * the Phase 1 forced-failure drill caught it.
   */
  html: string;
  tags: string[];
}

/** The /v1/send body for one recipient. */
export function buildMailWainPayload(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  kind: string;
}): MailWainSendPayload {
  return {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: renderAlertHtml(input.text),
    tags: ['signalgen', `alert:${input.kind}`],
  };
}

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  private readonly throttle = new AlertThrottle();
  /** When each failed delivery happened, pruned to the /healthz window. */
  private failures: Date[] = [];

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /**
   * Failed deliveries in the trailing window, for /healthz.
   *
   * Alerts are the last line of defence, so a failed send must be loud: it is
   * logged at error level and counted here, and /healthz turns a non-zero
   * count into a degraded status. In memory, so it resets on restart — the
   * error log is the durable record.
   */
  failedDeliveriesSince(since: Date): number {
    this.failures = this.failures.filter((at) => at.getTime() > since.getTime());
    return this.failures.length;
  }

  /**
   * Sends an alert to every configured recipient.
   *
   * Never throws. An alert is a side effect of a ledger decision that has
   * already been made and persisted; letting MailWain being down turn a
   * recorded `failed_permanent` into an unhandled exception would lose the
   * more important of the two facts. A failed delivery is instead logged at
   * error level and counted for /healthz (failedDeliveriesSince).
   */
  async send(alert: Alert): Promise<void> {
    const { subject, text } = renderAlert(alert);
    this.logger.warn(`Alert: ${subject}`);

    const recipients = this.config.get('ALERT_TO');
    await Promise.all(recipients.map((to) => this.deliver(to, subject, text, alert.kind)));
  }

  /**
   * Sends only the first time this `key` is seen today. Used for the tone gate,
   * which the brief scopes to one alert per adapter per day.
   */
  async sendThrottled(key: string, alert: Alert): Promise<void> {
    if (!this.throttle.shouldAlert(key)) {
      this.logger.debug(`Alert suppressed (already sent today): ${key}`);
      return;
    }
    await this.send(alert);
  }

  private async deliver(to: string, subject: string, text: string, kind: string): Promise<void> {
    const url = `${this.config.get('MAILWAIN_BASE_URL')}${SEND_PATH}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.get('MAILWAIN_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          buildMailWainPayload({ from: this.config.get('ALERT_FROM'), to, subject, text, kind }),
        ),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await safeText(response);
        this.recordFailure(`MailWain rejected alert "${subject}" to ${to}: HTTP ${response.status} ${body}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.recordFailure(`MailWain unreachable, alert "${subject}" to ${to} not delivered: ${reason}`);
    }
  }

  private recordFailure(message: string): void {
    this.failures.push(this.now());
    this.logger.error(`ALERT NOT DELIVERED — ${message}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '(unreadable body)';
  }
}
