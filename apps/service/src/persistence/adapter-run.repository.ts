import { Injectable } from '@nestjs/common';
import type { AdapterRun } from '@prisma/client';
import { PrismaService } from './prisma.service';

export interface RunCounts {
  itemsFetched: number;
  candidatesEmitted: number;
}

/**
 * `adapter_runs`: one row per adapter invocation, whatever the outcome
 * (architecture-spec.md §5).
 *
 * Written at the start as `running`, then finished. A run that crashes the
 * process therefore still leaves a row — one stuck at `running`, which is
 * itself the evidence.
 */
@Injectable()
export class AdapterRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  start(adapterKey: string, startedAt: Date): Promise<AdapterRun> {
    return this.prisma.adapterRun.create({ data: { adapterKey, startedAt, status: 'running' } });
  }

  finishOk(id: number, finishedAt: Date, counts: RunCounts): Promise<AdapterRun> {
    return this.prisma.adapterRun.update({
      where: { id },
      data: { status: 'ok', finishedAt, ...counts },
    });
  }

  finishFailed(id: number, finishedAt: Date, error: string, counts?: Partial<RunCounts>): Promise<AdapterRun> {
    return this.prisma.adapterRun.update({
      where: { id },
      data: { status: 'failed', finishedAt, error: error.slice(0, 2000), ...counts },
    });
  }
}
