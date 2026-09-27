import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AdapterKey } from '@signalgen/contract';
import type { RunContext } from '../adapters';
import { CLOCK, type Clock, systemClock } from '../common';
import { AdapterRunRepository, type RunCounts } from '../persistence';

export interface RunOutcome<T> extends RunCounts {
  result: T;
}

/**
 * Wraps one adapter invocation in its `adapter_runs` row: written `running`
 * before any work, finished `ok` with counts, or `failed` with the error.
 *
 * The error is recorded and rethrown. What happens next is the caller's call:
 * a push submission surfaces it to the submitter, and the Phase 2 cron runner
 * swallows it so one failing adapter never blocks another (spec §5).
 *
 * Manual records one run per submission, with itemsFetched = 1.
 */
@Injectable()
export class AdapterRunRecorder {
  private readonly logger = new Logger(AdapterRunRecorder.name);

  constructor(
    @Inject(AdapterRunRepository) private readonly runs: AdapterRunRepository,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async track<T>(
    adapterKey: AdapterKey,
    trigger: RunContext['trigger'],
    work: (ctx: RunContext) => Promise<RunOutcome<T>>,
  ): Promise<T> {
    const startedAt = this.now();
    const run = await this.runs.start(adapterKey, startedAt);

    let outcome: RunOutcome<T>;
    try {
      outcome = await work({ adapterKey, startedAt, trigger });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Adapter run ${run.id} (${adapterKey}) failed: ${message}`);
      await this.runs.finishFailed(run.id, this.now(), message);
      throw error;
    }

    await this.runs.finishOk(run.id, this.now(), {
      itemsFetched: outcome.itemsFetched,
      candidatesEmitted: outcome.candidatesEmitted,
    });
    return outcome.result;
  }
}
