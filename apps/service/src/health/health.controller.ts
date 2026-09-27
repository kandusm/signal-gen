import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type HealthReport, HealthService } from './health.service';

@Controller('healthz')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Status codes are chosen for what the platform does with them:
   *
   *   down     -> 503, the machine cannot do its job, replace it
   *   degraded -> 200, something is wrong but restarting would not fix it.
   *               Taxonomy served from a stale snapshot is the motivating
   *               case: a DM outage must not turn into a restart loop here.
   *
   * The body always carries the full report and an `issues` list, so a
   * degraded 200 is never silent.
   */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.report();
    res.status(report.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return report;
  }
}
