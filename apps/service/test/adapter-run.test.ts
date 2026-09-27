import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CandidateSignal } from '@signalgen/contract';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/common';
import { AdapterRunRecorder, DENYLIST_PATH, PolicyScreen } from '../src/pipeline';
import { FakeAdapterRunRepository } from './helpers/fakes';

const NOW = new Date('2026-09-27T12:00:00.000Z');

describe('AdapterRunRecorder', () => {
  function setup() {
    const clock = fixedClock(NOW);
    const runs = new FakeAdapterRunRepository();
    return { clock, runs, recorder: new AdapterRunRecorder(runs as never, clock) };
  }

  it('records a successful run with its counts and returns the result', async () => {
    const { clock, runs, recorder } = setup();

    const result = await recorder.track('manual', 'push', async (ctx) => {
      expect(runs.runs[0]?.status).toBe('running'); // written before any work
      expect(ctx).toEqual({ adapterKey: 'manual', startedAt: NOW, trigger: 'push' });
      clock.advance(250);
      return { result: 'done', itemsFetched: 1, candidatesEmitted: 1 };
    });

    expect(result).toBe('done');
    expect(runs.runs).toEqual([
      expect.objectContaining({
        adapterKey: 'manual',
        status: 'ok',
        startedAt: NOW,
        finishedAt: new Date(NOW.getTime() + 250),
        itemsFetched: 1,
        candidatesEmitted: 1,
      }),
    ]);
  });

  it('records a failed run with the error, then rethrows it', async () => {
    const { runs, recorder } = setup();

    await expect(
      recorder.track('manual', 'push', async () => {
        throw new Error('database went away');
      }),
    ).rejects.toThrow('database went away');

    expect(runs.runs[0]).toMatchObject({ status: 'failed', error: 'database went away' });
  });
});

describe('PolicyScreen — loading', () => {
  function file(content: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'denylist-')), 'denylist.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('ships an empty denylist that passes everything through', () => {
    const screen = PolicyScreen.fromFile(DENYLIST_PATH);
    expect(screen.ruleCount).toBe(0);
    expect(screen.screen({ topic: 'anything at all' } as CandidateSignal)).toBeNull();
  });

  it('applies defaults: word match, all scopes', () => {
    const screen = PolicyScreen.fromFile(file({ rules: [{ pattern: 'ford', reason: 'r' }] }));
    expect(screen.screen({ topic: 'Ford trucks' } as CandidateSignal)?.pattern).toBe('ford');
    // Word boundary: "afford" is not "ford".
    expect(screen.screen({ topic: 'afford' } as CandidateSignal)).toBeNull();
  });

  it('fails the boot on a malformed file rather than failing open', () => {
    expect(() => PolicyScreen.fromFile(file({ rules: [{ pattern: '', reason: 'r' }] }))).toThrow(
      /denylist .* is invalid/,
    );
    expect(() => PolicyScreen.fromFile(file({ rules: [{ pattern: 'x', match: 'regex', reason: 'r' }] }))).toThrow();
  });
});
