import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CLOCK, type Clock, systemClock } from '../common';
import { ConfigService } from '../config';
import { SignalRepository, SignalStatus } from '../persistence';
import { DmClient } from './dm.client';

/**
 * How many rows one sweep will look at.
 *
 * The per-minute token bucket holds ten, so a sweep can never dispatch more
 * than about ten before parking the rest anyway. Taking a few more than that
 * means a sweep whose first rows are budget-blocked can still reach rows from
 * a different adapter that is not.
 */
export const SWEEP_BATCH_SIZE = 25;

export interface SweepSummary {
  examined: number;
  posted: number;
  parked: number;
  failed: number;
}

/**
 * Drains parked rows, oldest first, and owns the retry schedule.
 *
 * Both jobs are the same query (see SignalRepository.findDispatchable): a row
 * parked over budget and a row waiting on a retry are both `pending`, and both
 * become eligible by the passage of time. Handling them together is what keeps
 * a retry backlog from starving fresh candidates.
 *
 * Single instance by design (build-plan.md section 1, fly.toml count = 1). If
 * that ever becomes more than one, this needs the advisory lock that
 * build-plan.md schedules for Phase 1.
 */
@Injectable()
export class SweepService {
  private readonly logger = new Logger(SweepService.name);
  private running = false;

  constructor(
    private readonly signals: SignalRepository,
    private readonly dm: DmClient,
    private readonly config: ConfigService,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'signal-sweep' })
  async handleCron(): Promise<void> {
    // Overlap guard. A sweep that honours a Retry-After inline can outlive its
    // five-minute slot, and two concurrent sweeps would double-dispatch the
    // same rows.
    if (this.running) {
      this.logger.warn('Sweep still running; skipping this tick');
      return;
    }

    this.running = true;
    try {
      const summary = await this.sweep();
      if (summary.examined > 0) {
        this.logger.log(
          `Sweep: examined=${summary.examined} posted=${summary.posted} ` +
            `parked=${summary.parked} failed=${summary.failed}`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Sweep failed: ${reason}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One drain pass. Exposed separately from the cron binding so it can be
   * driven directly in tests and from a future replay command.
   */
  async sweep(): Promise<SweepSummary> {
    const summary: SweepSummary = { examined: 0, posted: 0, parked: 0, failed: 0 };

    if (this.config.dryRun) {
      // Nothing in the ledger is awaiting dispatch in dry-run mode: postSignal
      // finalises as dry_run without ever leaving a row pending.
      return summary;
    }

    const due = await this.signals.findDispatchable(this.now(), SWEEP_BATCH_SIZE);

    for (const signal of due) {
      summary.examined += 1;
      const result = await this.dm.dispatch(signal);

      switch (result.status) {
        case SignalStatus.POSTED:
          summary.posted += 1;
          break;
        case SignalStatus.PENDING:
          summary.parked += 1;
          // A local rate-limit or budget block applies to every remaining row
          // for the same reason; continuing would just re-check the same
          // exhausted guard N more times.
          if (result.parkedReason === 'rate_limited_local') return summary;
          break;
        default:
          summary.failed += 1;
          break;
      }
    }

    return summary;
  }
}
