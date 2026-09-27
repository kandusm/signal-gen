/**
 * "First occurrence per key per day" gate.
 *
 * Used by the tone gate, where a contract drift affects every candidate an
 * adapter emits: the first one is a signal worth waking up for, the next
 * four hundred are the same news. Keyed by calendar day in UTC.
 *
 * In-process, matching the single-machine deployment. The consequence of a
 * restart is at most one duplicate alert, which is the right way round.
 */
import type { Clock } from '../common';

export class AlertThrottle {
  private readonly lastAlertedDay = new Map<string, string>();

  constructor(private readonly now: Clock = () => new Date()) {}

  /** True the first time it is called for `key` on any given UTC day. */
  shouldAlert(key: string): boolean {
    const today = this.now().toISOString().slice(0, 10);
    if (this.lastAlertedDay.get(key) === today) return false;
    this.lastAlertedDay.set(key, today);
    return true;
  }
}
