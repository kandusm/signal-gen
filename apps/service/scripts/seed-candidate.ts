/**
 * Dry-run rehearsal: build one valid CandidateSignal by hand, run it through
 * the real pipeline in DRY_RUN as a manual submission, and assert the ledger
 * row it produced.
 *
 * With dedup live (Phase 1), the first run within the manual suppression
 * window ends `dry_run` and every repeat ends `suppressed` — both are a pass,
 * and the output says which.
 *
 * Deliberately uses the actual Nest application context rather than wiring the
 * services up by hand. A rehearsal that constructs its own object graph proves
 * that the objects work; this proves that the application works.
 *
 *   pnpm --filter @signalgen/service seed:candidate
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { CandidateSignal } from '@signalgen/contract';
import { AppModule } from '../src/app.module';
import { ConfigService } from '../src/config';
import { SignalRepository, SignalStatus } from '../src/persistence';
import { AdapterRunRecorder, PipelineService } from '../src/pipeline';

/**
 * A hand-built candidate modelled on the sample body in docs/dm-contract.md.
 *
 * `tone: "Professional"` and `topic: "Trades"` / `subtopic: "Welding"` are
 * taken from the taxonomy example in the same document, so this candidate is
 * taxonomy-aligned when DM is reachable and the tone gate has something to
 * check against.
 */
function buildCandidate(now: Date): CandidateSignal {
  return {
    adapterKey: 'manual',
    capturedAt: now.toISOString(),
    topic: 'Trades',
    subtopic: 'Welding',
    tone: 'Professional',
    platform: 'LinkedIn',
    subplatform: 'Construction group',
    keywords: ['welding', 'PPE', 'hot work permit'],
    audience: 'trades professionals',
    sourceUrl: 'https://www.linkedin.com/posts/example',
    sourceAuthor: 'some-handle',
    sourceExcerpt: 'Seed candidate for the Phase 0 dry-run rehearsal.',
    engagementMetrics: { views: 12500, likes: 340, comments: 45, shares: 12 },
    observedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    signalDecayHint: 'SHORT',
    taxonomyAligned: true,
    extensions: { seededBy: 'scripts/seed-candidate.ts' },
  };
}

async function main(): Promise<void> {
  const logger = new Logger('seed-candidate');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const config = app.get(ConfigService);

    // The whole point of the rehearsal is that it cannot post. Refusing to run
    // outside DRY_RUN is cheaper than explaining an accidental real signal.
    if (!config.dryRun) {
      throw new Error(
        'seed-candidate refuses to run with DRY_RUN=false. It exists to rehearse ' +
          'the pipeline without touching Design Manager. The supervised first ' +
          'real post is a separate, human-driven step (build-plan.md section 4).',
      );
    }

    const pipeline = app.get(PipelineService);
    const runs = app.get(AdapterRunRecorder);
    const signals = app.get(SignalRepository);

    const candidate = buildCandidate(new Date());
    logger.log(`Submitting a hand-built ${candidate.adapterKey} candidate...`);

    const result = await runs.track(candidate.adapterKey, 'push', async (ctx) => ({
      result: await pipeline.process(candidate, ctx),
      itemsFetched: 1,
      candidatesEmitted: 1,
    }));

    const row = await signals.findById(result.signalId);
    if (!row) throw new Error(`No ledger row was written for ${result.signalId}`);

    const passing: string[] = [SignalStatus.DRY_RUN, SignalStatus.SUPPRESSED];
    if (!passing.includes(row.status)) {
      throw new Error(
        `Expected ledger status ${passing.join(' or ')}, found "${row.status}". ` +
          (row.dmResponse ? `Reason: ${JSON.stringify(row.dmResponse)}` : 'No reason recorded.'),
      );
    }

    logger.log('Ledger row:');
    logger.log(
      JSON.stringify(
        {
          id: row.id,
          status: row.status,
          adapterKey: row.adapterKey,
          sourceKey: row.sourceKey,
          topic: row.topic,
          subtopic: row.subtopic,
          tone: row.tone,
          platform: row.platform,
          fingerprint: row.fingerprint,
          attempts: row.attempts,
          postedAt: row.postedAt?.toISOString() ?? null,
          dmResponse: row.dmResponse,
          createdAt: row.createdAt.toISOString(),
        },
        null,
        2,
      ),
    );
    logger.log(`PASS: ${row.id} reached status=${row.status} end to end.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // eslint-disable-next-line no-console
  console.error(`\nseed-candidate FAILED\n${message}\n`);
  process.exitCode = 1;
});
