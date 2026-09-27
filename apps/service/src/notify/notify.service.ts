import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config';
import { AlertThrottle } from './alert-throttle';
import { renderAlert } from './alert.templates';
import type { Alert } from './alert.types';

/** MailWain's send endpoint (mail-wain docs/integration-guide.md §3). */
const SEND_PATH = '/v1/send';
const SEND_TIMEOUT_MS = 10_000;

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  private readonly throttle = new AlertThrottle();

  constructor(private readonly config: ConfigService) {}

  /**
   * Sends an alert to every configured recipient.
   *
   * Never throws. An alert is a side effect of a ledger decision that has
   * already been made and persisted; letting MailWain being down turn a
   * recorded `failed_permanent` into an unhandled exception would lose the
   * more important of the two facts. Failures are logged at error level, which
   * is itself visible in the container logs.
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
        body: JSON.stringify({
          from: this.config.get('ALERT_FROM'),
          to,
          subject,
          text,
          tags: ['signalgen', `alert:${kind}`],
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await safeText(response);
        this.logger.error(`MailWain rejected alert to ${to}: HTTP ${response.status} ${body}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`MailWain unreachable, alert to ${to} not delivered: ${reason}`);
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '(unreadable body)';
  }
}
