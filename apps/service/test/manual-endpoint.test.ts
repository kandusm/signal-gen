import type { INestApplication, LoggerService } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { CandidateSignal } from '@signalgen/contract';
import type { Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANUAL_THROTTLE,
  ManualAdapter,
  ManualController,
  ManualTokenGuard,
  clientIp,
} from '../src/adapters/manual';
import type { RunContext } from '../src/adapters';
import { CLOCK, fixedClock } from '../src/common';
import { ConfigService } from '../src/config';
import { TaxonomyService } from '../src/dm';
import { SignalStatus } from '../src/persistence';
import { AdapterRunRecorder, PipelineService } from '../src/pipeline';
import { FakeAdapterRunRepository } from './helpers/fakes';

/**
 * POST /manual/signals over real HTTP on loopback: real controller, guards,
 * throttler and run recorder; the pipeline and taxonomy are fakes. Nothing
 * leaves the machine.
 */
const TOKEN = 'test-token-with-some-length-0123456789';
const NOW = new Date('2026-09-27T12:00:00.000Z');

class FakePipeline {
  readonly calls: Array<{ candidate: CandidateSignal; ctx: RunContext }> = [];
  outcome: string = SignalStatus.DRY_RUN;
  async process(candidate: CandidateSignal, ctx: RunContext) {
    this.calls.push({ candidate, ctx });
    return { signalId: `man_${this.calls.length}`, status: this.outcome };
  }
}

let app: INestApplication | undefined;

async function boot() {
  const pipeline = new FakePipeline();
  const runs = new FakeAdapterRunRepository();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'manual', ...MANUAL_THROTTLE }],
        getTracker: (req) => clientIp(req as Request),
      }),
    ],
    controllers: [ManualController],
    providers: [
      ManualAdapter,
      ManualTokenGuard,
      { provide: ConfigService, useValue: { get: (key: string) => (key === 'MANUAL_API_TOKEN' ? TOKEN : undefined) } },
      { provide: PipelineService, useValue: pipeline },
      { provide: AdapterRunRecorder, useValue: new AdapterRunRecorder(runs as never, fixedClock(NOW)) },
      { provide: TaxonomyService, useValue: { isAlignedCategory: async (t: string) => t === 'Trades' } },
      { provide: CLOCK, useValue: fixedClock(NOW) },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;

  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    fetch(`${base}/manual/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return { pipeline, runs, post };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const VALID = { topic: 'Trades', subtopic: 'Welding', tone: 'Professional' };

describe('POST /manual/signals — authentication', () => {
  it.each([
    ['no Authorization header', {}],
    ['a wrong token of the same length', { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` }],
    ['a token of a different length', { authorization: 'Bearer short' }],
    ['the right token under another scheme', { authorization: `Basic ${TOKEN}` }],
    ['an empty bearer', { authorization: 'Bearer ' }],
  ])('answers 401 with an empty body for %s', async (_label, headers) => {
    const h = await boot();
    const response = await h.post(VALID, headers as Record<string, string>);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    // Not an invocation: no run, no pipeline.
    expect(h.runs.runs).toHaveLength(0);
    expect(h.pipeline.calls).toHaveLength(0);
  });

  it('never writes the token or the header to the logs', async () => {
    const lines: string[] = [];
    const capture: LoggerService = {
      log: (m) => lines.push(String(m)),
      error: (m) => lines.push(String(m)),
      warn: (m) => lines.push(String(m)),
      debug: (m) => lines.push(String(m)),
      verbose: (m) => lines.push(String(m)),
    };
    Logger.overrideLogger(capture);
    try {
      const h = await boot();
      await h.post(VALID);
      await h.post(VALID, { authorization: `Bearer ${TOKEN}x` });
      await h.post({ nope: true });
    } finally {
      Logger.overrideLogger(false);
    }
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('POST /manual/signals — submission', () => {
  it('runs the pipeline and answers 200 with the actual outcome', async () => {
    const h = await boot();
    for (const status of [
      SignalStatus.DRY_RUN,
      SignalStatus.SUPPRESSED,
      SignalStatus.PENDING,
      SignalStatus.POSTED,
      SignalStatus.REJECTED_SCHEMA,
      SignalStatus.REJECTED_TONE,
      SignalStatus.REJECTED_POLICY,
    ]) {
      h.pipeline.outcome = status;
      const response = await h.post(VALID);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ signalId: expect.stringMatching(/^man_/), status });
    }
  });

  it('builds the candidate with the operator defaults and taxonomy alignment', async () => {
    const h = await boot();
    await h.post(VALID);
    await h.post({ topic: 'Knitting', tone: 'Humor', keywords: ['yarn'] });

    expect(h.pipeline.calls[0]?.candidate).toEqual({
      adapterKey: 'manual',
      capturedAt: '2026-09-27T12:00:00.000Z',
      topic: 'Trades',
      subtopic: 'Welding',
      tone: 'Professional',
      platform: 'Manual',
      signalDecayHint: 'SHORT',
      taxonomyAligned: true,
    });
    expect(h.pipeline.calls[1]?.candidate).toMatchObject({ taxonomyAligned: false, keywords: ['yarn'] });
    expect(h.pipeline.calls[0]?.ctx).toEqual({ adapterKey: 'manual', startedAt: NOW, trigger: 'push' });
  });

  it('records one adapter run per submission, with itemsFetched = 1', async () => {
    const h = await boot();
    await h.post(VALID);
    await h.post(VALID);
    expect(h.runs.runs).toHaveLength(2);
    expect(h.runs.runs[0]).toMatchObject({ adapterKey: 'manual', status: 'ok', itemsFetched: 1, candidatesEmitted: 1 });
  });

  it('answers 400 with the issues for an invalid body, and records a failed run', async () => {
    const h = await boot();
    const response = await h.post({ topic: 'Trades', subtopic: 'Welding' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('INVALID_SUBMISSION');
    expect(body.issues).toEqual([expect.objectContaining({ path: 'tone' })]);
    expect(h.pipeline.calls).toHaveLength(0);
    expect(h.runs.runs[0]).toMatchObject({ status: 'failed' });
  });
});

describe('POST /manual/signals — throttle', () => {
  it('allows 10 a minute per IP and answers 429 to the 11th', async () => {
    const h = await boot();
    for (let i = 0; i < MANUAL_THROTTLE.limit; i += 1) {
      expect((await h.post(VALID)).status).toBe(200);
    }
    expect((await h.post(VALID)).status).toBe(429);
  });

  it('throttles before authenticating, so token guessing is rate-limited too', async () => {
    const h = await boot();
    const wrong = { authorization: 'Bearer guess' };
    for (let i = 0; i < MANUAL_THROTTLE.limit; i += 1) {
      expect((await h.post(VALID, wrong)).status).toBe(401);
    }
    expect((await h.post(VALID, wrong)).status).toBe(429);
  });

  it('keys the bucket on Fly-Client-IP, so callers behind the proxy do not share one', async () => {
    const h = await boot();
    const as = (ip: string) => ({ authorization: `Bearer ${TOKEN}`, 'fly-client-ip': ip });
    for (let i = 0; i < MANUAL_THROTTLE.limit; i += 1) await h.post(VALID, as('203.0.113.1'));

    expect((await h.post(VALID, as('203.0.113.1'))).status).toBe(429);
    expect((await h.post(VALID, as('203.0.113.2'))).status).toBe(200);
  });
});
