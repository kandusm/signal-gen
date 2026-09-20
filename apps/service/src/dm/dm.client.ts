import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Signal } from '@prisma/client';
import {
  type CandidateSignal,
  dmResponseSchemas,
  dmSignalPayloadSchema,
} from '@signalgen/contract';
import { CLOCK, type Clock, SLEEP, type Sleep, realSleep, systemClock } from '../common';
import { ConfigService } from '../config';
import { NotifyService } from '../notify';
import { SignalRepository, SignalStatus } from '../persistence';
import { BudgetService } from './budget.service';
import { DmHttpClient, type DmHttpResult } from './dm.http';
import { fingerprintFor } from './fingerprint';
import {
  type LedgerResponse,
  describeLedgerResponse,
  fromDmResponse,
  fromSchemaRejection,
  fromToneRejection,
  fromTransportError,
} from './ledger-response';
import { buildDmPayload } from './payload.builder';
import { RateLimitService } from './rate-limit.service';
import { MAX_ATTEMPTS, classifyStatus, nextRetryDelayMs, parseRetryAfterSeconds } from './retry';
import { buildSignalId } from './signal-id';
import { TaxonomyService } from './taxonomy.service';

/**
 * Longest we will block a worker honouring a Retry-After before parking the
 * row for the sweep instead.
 *
 * The brief says to wait out a 429 and retry, and the documented Retry-After
 * is 42 seconds, so the common case is an inline wait. An uncapped inline
 * sleep on a cron worker is a different matter: a proxy answering with
 * "Retry-After: 3600" would stall the sweep for an hour. Past the cap the row
 * is scheduled rather than awaited, which reaches the same place without
 * holding the worker.
 */
export const INLINE_RETRY_WAIT_CAP_MS = 120_000;

/** At most one inline 429 retry per dispatch; a second one is scheduled. */
const MAX_INLINE_RETRIES = 1;

export interface DispatchResult {
  signalId: string;
  status: SignalStatus;
  /** Why a row was left pending, when it was. */
  parkedReason?: 'rate_limited_local' | 'budget_exhausted' | 'retry_scheduled';
}

@Injectable()
export class DmClient {
  private readonly logger = new Logger(DmClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: DmHttpClient,
    private readonly signals: SignalRepository,
    private readonly budget: BudgetService,
    private readonly rateLimit: RateLimitService,
    private readonly taxonomy: TaxonomyService,
    private readonly notify: NotifyService,
    @Optional() @Inject(CLOCK) private readonly now: Clock = systemClock,
    @Optional() @Inject(SLEEP) private readonly sleep: Sleep = realSleep,
  ) {}

  /**
   * Takes a candidate all the way to a ledger outcome.
   *
   * The ordering below is the load-bearing part of this class:
   *
   *   1. assign signalId          deterministic idempotency key
   *   2. write the ledger row     BEFORE any network call, so a crash during
   *                               dispatch leaves a recoverable `pending` row
   *                               rather than an unknown
   *   3. validate the payload     our own contract check; a failure here is a
   *                               bug we should never have put on the wire
   *   4. tone gate                catches taxonomy drift before DM 400s
   *   5. dry-run short-circuit    no network, no quota
   *   6. rate guards, then POST   see dispatch()
   */
  async postSignal(candidate: CandidateSignal): Promise<DispatchResult> {
    const signalId = buildSignalId(
      candidate.adapterKey,
      this.config.shortcodeFor(candidate.adapterKey),
    );
    const sourceKey = this.config.generatorSourceKey;
    const payload = buildDmPayload(candidate, { signalId, sourceKey });

    // (2) Ledger first. Everything after this updates a row that already exists.
    await this.signals.createPending({
      id: signalId,
      fingerprint: fingerprintFor(candidate),
      adapterKey: candidate.adapterKey,
      sourceKey,
      topic: candidate.topic,
      subtopic: candidate.subtopic,
      tone: candidate.tone,
      platform: candidate.platform,
      payload: payload as never,
    });
    this.logger.log(`Ledgered ${signalId} (${candidate.adapterKey}) as pending`);

    // (3) Our own wire-contract check.
    const parsed = dmSignalPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      }));
      this.logger.error(
        `Schema rejected ${signalId}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      );
      await this.signals.finalize(signalId, {
        status: SignalStatus.REJECTED_SCHEMA,
        dmResponse: fromSchemaRejection(issues),
      });
      return { signalId, status: SignalStatus.REJECTED_SCHEMA };
    }

    // (4) Tone gate.
    const toneValid = await this.taxonomy.isValidTone(candidate.tone);
    if (toneValid === false) {
      const knownTones = this.taxonomy.peek()?.taxonomy.tones ?? [];
      this.logger.error(`Tone "${candidate.tone}" rejected for ${signalId}`);
      await this.signals.finalize(signalId, {
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
      return { signalId, status: SignalStatus.REJECTED_TONE };
    }
    if (toneValid === 'unknown') {
      // No taxonomy at all. dm-contract.md says an unrecognised tone still
      // matches via Tier 2/3, so this degrades match quality rather than
      // blocking the signal.
      this.logger.warn(`Tone gate skipped for ${signalId}: no taxonomy available`);
    }

    // (5) Dry run. Checked before the rate guards on purpose: a rehearsal makes
    // no DM request, so it consumes no DM quota and must not be blocked by a
    // budget that exists to protect that quota.
    if (this.config.dryRun) {
      await this.signals.finalize(signalId, { status: SignalStatus.DRY_RUN });
      this.logger.log(`DRY_RUN: ${signalId} ledgered as dry_run, not sent`);
      return { signalId, status: SignalStatus.DRY_RUN };
    }

    const row = await this.signals.findById(signalId);
    if (!row) throw new Error(`Ledger row ${signalId} vanished between write and dispatch`);
    return this.dispatch(row);
  }

  /**
   * Rate guards, then POST, then ledger the outcome.
   *
   * Also the sweep's entry point for a row that was parked, which is why it
   * works from a persisted row rather than from a candidate.
   */
  async dispatch(signal: Signal): Promise<DispatchResult> {
    // Per-minute guard. Failing it is not an error; the sweep will come back.
    if (!this.rateLimit.tryAcquire()) {
      this.logger.log(
        `${signal.id} parked: local rate limit, next token in ${this.rateLimit.msUntilNextToken()}ms`,
      );
      return {
        signalId: signal.id,
        status: SignalStatus.PENDING,
        parkedReason: 'rate_limited_local',
      };
    }

    // Daily guard.
    const decision = await this.budget.check(signal.adapterKey, this.now());
    if (!decision.allowed) {
      this.logger.log(
        `${signal.id} parked: ${decision.reason} (${decision.used}/${decision.limit} in trailing 24h)`,
      );
      return { signalId: signal.id, status: SignalStatus.PENDING, parkedReason: 'budget_exhausted' };
    }

    return this.attempt(signal, 0);
  }

  /** One network attempt plus its ledger consequence. */
  private async attempt(signal: Signal, inlineRetries: number): Promise<DispatchResult> {
    const updated = await this.signals.incrementAttempts(signal.id);
    const attemptsMade = updated.attempts;

    const result = await this.http.postSignal(signal.payload, signal.id);
    return this.handleResult(updated, result, attemptsMade, inlineRetries);
  }

  private async handleResult(
    signal: Signal,
    result: DmHttpResult,
    attemptsMade: number,
    inlineRetries: number,
  ): Promise<DispatchResult> {
    // No response at all: retryable transport failure.
    if (result.kind === 'transport_error') {
      return this.scheduleOrFail(signal, attemptsMade, {
        dmResponse: fromTransportError(result.message),
      });
    }

    const outcome = classifyStatus(result.status);

    switch (outcome) {
      case 'accepted': {
        const parsed = dmResponseSchemas.accepted.safeParse(result.body);
        if (!parsed.success) {
          // DM said 202 but not in the documented shape. It has the signal
          // either way, so this is an anomaly to look at, not a reason to
          // re-send and risk a duplicate.
          this.logger.warn(`${signal.id}: 202 with an unexpected body: ${result.rawBody}`);
        } else if (!parsed.data.matchingScheduled) {
          this.logger.warn(`${signal.id}: accepted but matchingScheduled=false`);
        }
        return this.markPosted(signal, result.status, fromDmResponse(result));
      }

      case 'duplicate': {
        const parsed = dmResponseSchemas.duplicate.safeParse(result.body);
        // A DUPLICATE means we sent something DM already had. Expected after a
        // transport error that actually landed; unexpected on a first attempt,
        // where it points at an idempotency-key collision or a lost ledger.
        this.logger.warn(
          `${signal.id}: DM reports DUPLICATE on attempt ${attemptsMade}` +
            (parsed.success ? ` (originally captured ${parsed.data.originalCapturedAt})` : ''),
        );
        return this.markPosted(signal, result.status, fromDmResponse(result));
      }

      case 'accepted_undocumented': {
        this.logger.warn(`${signal.id}: undocumented success status ${result.status}`);
        return this.markPosted(signal, result.status, fromDmResponse(result));
      }

      case 'rate_limited': {
        const retryAfterSeconds = parseRetryAfterSeconds(result.retryAfter, this.now());
        const usage = await this.budget.usage(this.now());

        // Always alerted: client-side accounting is supposed to make a 429
        // impossible, so one happening is an accounting bug (spec section 6).
        await this.notify.send({
          kind: 'rate_limited',
          signalId: signal.id,
          status: SignalStatus.PENDING,
          adapterKey: signal.adapterKey,
          retryAfterSeconds,
          usageTotal: usage.total,
          usageForAdapter: usage.byAdapter[signal.adapterKey] ?? 0,
        });

        const waitMs = (retryAfterSeconds ?? 0) * 1000;
        const canWaitInline =
          inlineRetries < MAX_INLINE_RETRIES &&
          waitMs > 0 &&
          waitMs <= INLINE_RETRY_WAIT_CAP_MS &&
          attemptsMade < MAX_ATTEMPTS;

        if (canWaitInline) {
          this.logger.warn(`${signal.id}: 429, honouring Retry-After of ${retryAfterSeconds}s`);
          await this.sleep(waitMs);
          if (!this.rateLimit.tryAcquire()) {
            return this.scheduleOrFail(signal, attemptsMade, {
              dmStatusCode: result.status,
              dmResponse: fromDmResponse(result),
            });
          }
          return this.attempt(signal, inlineRetries + 1);
        }

        // Too long to wait inline, or we already retried once.
        return this.scheduleOrFail(signal, attemptsMade, {
          dmStatusCode: result.status,
          dmResponse: fromDmResponse(result),
          overrideDelayMs: waitMs > 0 ? waitMs : undefined,
        });
      }

      case 'permanent': {
        this.logger.error(`${signal.id}: permanent failure, HTTP ${result.status}`);
        const body = fromDmResponse(result);
        await this.signals.finalize(signal.id, {
          status: SignalStatus.FAILED_PERMANENT,
          dmStatusCode: result.status,
          dmResponse: body,
        });
        await this.notify.send({
          kind: 'permanent_failure',
          signalId: signal.id,
          status: SignalStatus.FAILED_PERMANENT,
          adapterKey: signal.adapterKey,
          dmStatusCode: result.status,
          dmResponse: describeLedgerResponse(body),
        });
        return { signalId: signal.id, status: SignalStatus.FAILED_PERMANENT };
      }

      case 'retryable': {
        return this.scheduleOrFail(signal, attemptsMade, {
          dmStatusCode: result.status,
          dmResponse: fromDmResponse(result),
        });
      }
    }
  }

  private async markPosted(
    signal: Signal,
    statusCode: number,
    body: LedgerResponse,
  ): Promise<DispatchResult> {
    await this.signals.finalize(signal.id, {
      status: SignalStatus.POSTED,
      dmStatusCode: statusCode,
      dmResponse: body,
      postedAt: this.now(),
    });
    this.logger.log(`${signal.id}: posted (HTTP ${statusCode})`);
    return { signalId: signal.id, status: SignalStatus.POSTED };
  }

  /**
   * Books the next retry, or parks the row as `failed` when the schedule is
   * spent. `overrideDelayMs` lets a 429 Retry-After take precedence over the
   * schedule for that one hop.
   */
  private async scheduleOrFail(
    signal: Signal,
    attemptsMade: number,
    outcome: {
      dmStatusCode?: number | undefined;
      dmResponse?: LedgerResponse | undefined;
      overrideDelayMs?: number | undefined;
    },
  ): Promise<DispatchResult> {
    const scheduledDelay = nextRetryDelayMs(attemptsMade);

    if (scheduledDelay === null) {
      await this.signals.finalize(signal.id, {
        status: SignalStatus.FAILED,
        dmStatusCode: outcome.dmStatusCode,
        dmResponse: outcome.dmResponse,
      });
      this.logger.error(`${signal.id}: retry schedule exhausted after ${attemptsMade} attempts`);
      await this.notify.send({
        kind: 'retry_exhaustion',
        signalId: signal.id,
        status: SignalStatus.FAILED,
        adapterKey: signal.adapterKey,
        attempts: attemptsMade,
        lastError: describeLedgerResponse(outcome.dmResponse),
      });
      return { signalId: signal.id, status: SignalStatus.FAILED };
    }

    const delayMs = Math.max(outcome.overrideDelayMs ?? 0, scheduledDelay);
    const nextAttemptAt = new Date(this.now().getTime() + delayMs);
    await this.signals.scheduleRetry(signal.id, nextAttemptAt, {
      dmStatusCode: outcome.dmStatusCode,
      dmResponse: outcome.dmResponse,
    });
    this.logger.warn(
      `${signal.id}: attempt ${attemptsMade} failed, next attempt at ${nextAttemptAt.toISOString()}`,
    );
    return {
      signalId: signal.id,
      status: SignalStatus.PENDING,
      parkedReason: 'retry_scheduled',
    };
  }
}
