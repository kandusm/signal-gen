import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Optional,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { manualSubmissionSchema } from '@signalgen/contract';
import { CLOCK, type Clock, systemClock } from '../../common';
import { TaxonomyService } from '../../dm';
import type { SignalStatus } from '../../persistence';
import { AdapterRunRecorder, PipelineService } from '../../pipeline';
import { EmptyUnauthorizedFilter, ManualTokenGuard } from './manual-token.guard';
import { ManualAdapter } from './manual.adapter';

export interface ManualSubmitResponse {
  signalId: string;
  /** The pipeline's actual outcome: dry_run, suppressed, rejected_*, pending, posted… */
  status: SignalStatus;
}

/** Thrown inside the recorded run so the run is marked failed; mapped to 400 below. */
class InvalidSubmission extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`invalid submission: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
}

/**
 * POST /manual/signals (architecture-spec.md §9.1).
 *
 * Guards run in order: the throttle first, so unauthenticated guessing is
 * rate-limited too; then the bearer token. A request that clears both is an
 * adapter invocation and gets an `adapter_runs` row — including one whose
 * body fails validation, which is recorded as a failed run and answered 400.
 *
 * Every body that validates answers 200 with the real pipeline outcome, even
 * when that outcome is a rejection or a suppression: the submission was
 * handled, and the status says how.
 */
@Controller('manual')
@UseGuards(ThrottlerGuard, ManualTokenGuard)
@UseFilters(EmptyUnauthorizedFilter)
export class ManualController {
  constructor(
    @Inject(ManualAdapter) private readonly adapter: ManualAdapter,
    @Inject(PipelineService) private readonly pipeline: PipelineService,
    @Inject(AdapterRunRecorder) private readonly runs: AdapterRunRecorder,
    @Inject(TaxonomyService) private readonly taxonomy: TaxonomyService,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  @Post('signals')
  @HttpCode(200)
  async submit(@Body() body: unknown): Promise<ManualSubmitResponse> {
    try {
      return await this.runs.track(this.adapter.key, 'push', async (ctx) => {
        const parsed = manualSubmissionSchema.safeParse(body);
        if (!parsed.success) {
          throw new InvalidSubmission(
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.') || '(root)',
              message: issue.message,
            })),
          );
        }

        const submission = parsed.data;
        const aligned = await this.taxonomy.isAlignedCategory(submission.topic, submission.subtopic);
        const candidate = this.adapter.toCandidate(submission, this.now(), aligned);
        const { signalId, status } = await this.pipeline.process(candidate, ctx);
        return { result: { signalId, status }, itemsFetched: 1, candidatesEmitted: 1 };
      });
    } catch (error) {
      if (error instanceof InvalidSubmission) {
        throw new BadRequestException({ error: 'INVALID_SUBMISSION', issues: error.issues });
      }
      throw error;
    }
  }
}
