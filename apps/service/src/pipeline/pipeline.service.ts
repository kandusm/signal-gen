import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  type CandidateSignal,
  candidateSignalSchema,
  dmSignalPayloadSchema,
} from '@signalgen/contract';
import type { ZodError } from 'zod';
import { AdapterRegistry, type RunContext } from '../adapters';
import { CLOCK, type Clock, systemClock } from '../common';
import { ConfigService } from '../config';
import {
  type DispatchResult,
  DmClient,
  TaxonomyService,
  buildDmPayload,
  buildSignalId,
  fromPolicyRejection,
  fromSchemaRejection,
  fromToneRejection,
} from '../dm';
import { NotifyService } from '../notify';
import {
  type CreatePendingInput,
  FingerprintRepository,
  SignalRepository,
  SignalStatus,
} from '../persistence';
import { fingerprintOf } from './fingerprint';
import { PolicyScreen } from './policy/policy-screen';

export type PipelineResult = DispatchResult;

/**
 * The single entry point every adapter's candidates go through
 * (Phase 1 brief §3, architecture-spec.md §4–§5). Stage order is load-bearing:
 *
 *   1. schema        contract candidateSignalSchema, then the built payload
 *                    → rejected_schema
 *   2. policy        denylist screen → rejected_policy (no fingerprint write,
 *                    so a denylist edit takes effect on the very next candidate)
 *   3. tone gate     match-quality check → rejected_tone. Before dedup, so a
 *                    rejected candidate never claims a fingerprint and cannot
 *                    suppress a corrected resubmission.
 *   4. fingerprint   sha256(adapterKey | adapter.fingerprintMaterial(c))
 *   5. dedup+ledger  one transaction: live fingerprint → suppressed row;
 *                    otherwise claim it and write the pending row
 *   6. dispatch      DmClient.dispatch (DRY_RUN skips only the POST)
 *
 * Every outcome writes a Signal row. Nothing reaches the network before a
 * pending row with its final signalId exists.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AdapterRegistry) private readonly adapters: AdapterRegistry,
    @Inject(PolicyScreen) private readonly policy: PolicyScreen,
    @Inject(TaxonomyService) private readonly taxonomy: TaxonomyService,
    @Inject(SignalRepository) private readonly signals: SignalRepository,
    @Inject(FingerprintRepository) private readonly fingerprints: FingerprintRepository,
    @Inject(DmClient) private readonly dm: DmClient,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async process(candidate: CandidateSignal, ctx: RunContext): Promise<PipelineResult> {
    const adapter = this.adapters.get(ctx.adapterKey);
    const signalId = buildSignalId(ctx.adapterKey, this.config.shortcodeFor(ctx.adapterKey));
    const sourceKey = this.config.generatorSourceKey;

    // (1) Schema. Until it passes, no field can be trusted, so the rejected row
    // records what it can and no fingerprint.
    const parsed = candidateSignalSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.adapterKey !== ctx.adapterKey) {
      const issues = parsed.success
        ? [{ path: 'adapterKey', message: `expected "${ctx.adapterKey}" for this run` }]
        : issuesOf(parsed.error);
      return this.reject(signalId, rowFor(candidate, { adapterKey: ctx.adapterKey, signalId, sourceKey, fingerprint: '' }), {
        status: SignalStatus.REJECTED_SCHEMA,
        dmResponse: fromSchemaRejection(issues),
      });
    }

    const payload = buildDmPayload(candidate, { signalId, sourceKey });
    const fingerprint = fingerprintOf(ctx.adapterKey, adapter.fingerprintMaterial(candidate));
    const row = rowFor(candidate, { adapterKey: ctx.adapterKey, signalId, sourceKey, fingerprint, payload });

    // The payload is what goes on the wire; checking it too catches a builder
    // bug that the candidate schema cannot see.
    const wire = dmSignalPayloadSchema.safeParse(payload);
    if (!wire.success) {
      return this.reject(signalId, row, {
        status: SignalStatus.REJECTED_SCHEMA,
        dmResponse: fromSchemaRejection(issuesOf(wire.error)),
      });
    }

    // (2) Policy screen.
    const rule = this.policy.screen(candidate);
    if (rule) {
      return this.reject(signalId, row, {
        status: SignalStatus.REJECTED_POLICY,
        dmResponse: fromPolicyRejection(rule),
      });
    }

    // (3) Tone gate.
    const tone = await this.taxonomy.isValidTone(candidate.tone);
    if (tone === false) {
      const knownTones = this.taxonomy.peek()?.taxonomy.tones ?? [];
      const result = await this.reject(signalId, row, {
        status: SignalStatus.REJECTED_TONE,
        dmResponse: fromToneRejection(candidate.tone, knownTones),
      });
      // One alert per adapter per day: a drift hits every candidate an adapter
      // emits, and the first one carries all the information.
      await this.notify.sendThrottled(`tone_rejection:${candidate.adapterKey}`, {
        kind: 'tone_rejection',
        signalId,
        status: SignalStatus.REJECTED_TONE,
        adapterKey: candidate.adapterKey,
        tone: candidate.tone,
        knownTones,
      });
      return result;
    }
    if (tone === 'no_taxonomy' || tone === 'no_tones') {
      // DM does not validate tone and an unrecognised one still matches via
      // Tier 2/3 (dm-contract.md), so this degrades match quality rather than
      // blocking the signal.
      const reason = tone === 'no_taxonomy' ? 'no taxonomy available' : 'DM publishes no tones';
      this.logger.warn(`Tone gate skipped for ${signalId}: ${reason}`);
    }

    // (4)+(5) Fingerprint, dedup and the ledger row, atomically.
    const windowMs = this.config.suppressionWindowMs(ctx.adapterKey);
    if (windowMs === undefined) {
      // AdapterRegistry refuses to boot without one; reaching here is a bug.
      throw new Error(`No suppression window configured for "${ctx.adapterKey}"`);
    }
    const admitted = await this.fingerprints.admit({ signal: row, now: this.now(), windowMs });
    if (admitted.outcome === 'suppressed') {
      this.logger.log(`Suppressed ${signalId} (${ctx.adapterKey}): fingerprint ${fingerprint.slice(0, 12)} is live`);
      return { signalId, status: SignalStatus.SUPPRESSED };
    }
    this.logger.log(`Ledgered ${signalId} (${ctx.adapterKey}) as pending`);

    // (6) Dispatch.
    return this.dm.dispatch(admitted.signal);
  }

  private async reject(
    signalId: string,
    row: CreatePendingInput,
    update: { status: SignalStatus; dmResponse: ReturnType<typeof fromSchemaRejection> },
  ): Promise<PipelineResult> {
    await this.signals.createRejected(row, update);
    this.logger.warn(`${update.status}: ${signalId} (${row.adapterKey})`);
    return { signalId, status: update.status };
  }
}

function issuesOf(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Ledger columns for a candidate. Tolerates a schema-invalid candidate: the
 * row must still be writable to record why it was rejected.
 */
function rowFor(
  candidate: CandidateSignal,
  ids: { adapterKey: string; signalId: string; sourceKey: string; fingerprint: string; payload?: unknown },
): CreatePendingInput {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    id: ids.signalId,
    fingerprint: ids.fingerprint,
    // The run's key, not the candidate's: an invalid candidate may lack one.
    adapterKey: ids.adapterKey,
    sourceKey: ids.sourceKey,
    topic: text(candidate.topic),
    subtopic: typeof candidate.subtopic === 'string' ? candidate.subtopic : undefined,
    tone: text(candidate.tone),
    platform: text(candidate.platform),
    payload: (ids.payload ?? candidate) as never,
  };
}
