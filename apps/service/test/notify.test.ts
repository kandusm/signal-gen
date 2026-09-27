import { Logger, type LoggerService } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../src/common';
import { ALERT_FAILURE_WINDOW_MS, NotifyService, buildMailWainPayload, renderAlertHtml } from '../src/notify';
import { SignalStatus } from '../src/persistence';

/**
 * NotifyService against a stubbed global fetch standing in for MailWain.
 * Nothing leaves the process.
 */
const NOW = new Date('2026-09-27T12:00:00.000Z');

const config = {
  get(key: string) {
    return (
      {
        MAILWAIN_BASE_URL: 'https://mailwain.test',
        MAILWAIN_API_KEY: 'mw-key',
        ALERT_FROM: 'noreply@example.test',
        ALERT_TO: ['ops@example.test'],
      } as Record<string, unknown>
    )[key];
  },
};

const ALERT = {
  kind: 'permanent_failure' as const,
  signalId: 'man_01DRILL',
  status: SignalStatus.FAILED_PERMANENT,
  adapterKey: 'manual',
  dmStatusCode: 401,
  dmResponse: '{"message":"Invalid bearer token"}',
};

function setup(respond: () => Promise<Response>) {
  const clock = fixedClock(NOW);
  const fetchMock = vi.fn(respond);
  vi.stubGlobal('fetch', fetchMock);
  const errors: string[] = [];
  const capture: LoggerService = {
    log: () => {},
    warn: () => {},
    debug: () => {},
    verbose: () => {},
    error: (m) => errors.push(String(m)),
  };
  Logger.overrideLogger(capture);
  return { clock, fetchMock, errors, notify: new NotifyService(config as never, clock) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Logger.overrideLogger(false);
});

describe('MailWain payload', () => {
  it('carries exactly one of html or template, as /v1/send requires', () => {
    const payload = buildMailWainPayload({ from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't', kind: 'k' });
    const bodies = ['html', 'template'].filter((key) => key in payload);
    expect(bodies).toEqual(['html']);
    expect(payload.html.length).toBeGreaterThan(0);
  });

  it('renders the same alert text into the html, escaped', () => {
    const html = renderAlertHtml('signalId: man_1\n<script>&"');
    expect(html).toContain('signalId: man_1\n&lt;script&gt;&amp;&quot;');
    expect(html).not.toContain('<script>');
  });

  it('is what NotifyService actually sends, and names the signal and its status', async () => {
    const h = setup(async () => new Response('{}', { status: 202 }));
    await h.notify.send(ALERT);

    const body = JSON.parse((h.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ from: 'noreply@example.test', to: 'ops@example.test' });
    expect('html' in body !== 'template' in body).toBe(true);
    for (const part of [body.subject + body.text, body.html]) {
      expect(part).toContain('man_01DRILL');
    }
    expect(body.text).toContain(SignalStatus.FAILED_PERMANENT);
    expect(body.html).toContain(SignalStatus.FAILED_PERMANENT);
  });
});

describe('NotifyService — a failed send is loud', () => {
  it('logs a rejected send at error level and counts it', async () => {
    const h = setup(async () => new Response('{"error":"Bad Request"}', { status: 400 }));
    await h.notify.send(ALERT);

    expect(h.errors).toEqual([expect.stringContaining('ALERT NOT DELIVERED')]);
    expect(h.errors[0]).toContain('HTTP 400');
    expect(h.notify.failedDeliveriesSince(new Date(NOW.getTime() - ALERT_FAILURE_WINDOW_MS))).toBe(1);
  });

  it('logs and counts an unreachable MailWain, and still never throws', async () => {
    const h = setup(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(h.notify.send(ALERT)).resolves.toBeUndefined();
    expect(h.errors[0]).toContain('ALERT NOT DELIVERED');
    expect(h.notify.failedDeliveriesSince(new Date(0))).toBe(1);
  });

  it('counts nothing when MailWain accepts', async () => {
    const h = setup(async () => new Response('{}', { status: 202 }));
    await h.notify.send(ALERT);
    expect(h.errors).toEqual([]);
    expect(h.notify.failedDeliveriesSince(new Date(0))).toBe(0);
  });

  it('forgets failures older than the window', async () => {
    const h = setup(async () => new Response('', { status: 500 }));
    await h.notify.send(ALERT);
    h.clock.advance(ALERT_FAILURE_WINDOW_MS);
    const since = new Date(h.clock().getTime() - ALERT_FAILURE_WINDOW_MS);
    expect(h.notify.failedDeliveriesSince(since)).toBe(0);
  });
});
