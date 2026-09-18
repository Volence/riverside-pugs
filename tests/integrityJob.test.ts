import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openDb, type DB } from '../src/db.js';
import { IntegrityJobs, matchInFlight, pendingRoundCount, type JobChild, type JobMode } from '../src/integrity/job.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

/** A stand-in for the analysis process, driven by the test. */
class FakeChild extends EventEmitter implements JobChild {
  stdout = new EventEmitter() as unknown as JobChild['stdout'];
  stderr = new EventEmitter() as unknown as JobChild['stderr'];
  say(text: string): void { (this.stdout as unknown as EventEmitter).emit('data', text); }
  complain(text: string): void { (this.stderr as unknown as EventEmitter).emit('data', text); }
  finish(code: number | null): void { this.emit('exit', code); }
}

let db: DB;
let spawned: { mode: JobMode; child: FakeChild }[];
let busy: boolean;
let jobs: IntegrityJobs;

function build(overrides: { spawn?: () => JobChild } = {}): IntegrityJobs {
  return new IntegrityJobs({
    spawn: overrides.spawn ?? ((mode) => {
      const child = new FakeChild();
      spawned.push({ mode, child });
      return child;
    }),
    busy: () => busy,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  spawned = [];
  busy = false;
  jobs = build();
});

describe('matchInFlight', () => {
  it('is true for a match that is live, configuring or waiting, and false once it is over', () => {
    const ins = db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, ?, 'no_mercy')");
    expect(matchInFlight(db)).toBe(false);
    ins.run('completed');
    expect(matchInFlight(db)).toBe(false);
    ins.run('configuring');
    expect(matchInFlight(db)).toBe(true);
  });
});

describe('pendingRoundCount', () => {
  /** An indexed round, optionally already measured. */
  const seed = (ordinal: number, measuredWith?: number) => {
    db.prepare('INSERT OR IGNORE INTO matches (id, season_id, state, campaign) VALUES (1, 1, \'completed\', \'no_mercy\')').run();
    db.prepare('INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, ?, 1, ?, 0, 0, 10)')
      .run(ordinal, `pug_${'a'.repeat(32)}_${ordinal}_1.rpl`);
    if (measuredWith !== undefined) {
      db.prepare(
        `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
         VALUES (1, ?, 1, 0, 'x', ?, '{}', datetime('now'))`,
      ).run(ordinal, measuredWith);
    }
  };

  it('counts indexed rounds nothing has measured', () => {
    expect(pendingRoundCount(db)).toBe(0);
    seed(0);
    seed(1, ANALYZER_VERSION);
    expect(pendingRoundCount(db)).toBe(1);
  });

  it('counts a round measured by an older analyzer as pending', () => {
    seed(0, ANALYZER_VERSION - 1);
    expect(pendingRoundCount(db)).toBe(1);
  });
});

describe('IntegrityJobs', () => {
  it('starts idle, with nothing to report', () => {
    expect(jobs.snapshot()).toMatchObject({ status: 'idle', mode: null, output: [] });
  });

  it('spawns the analysis and keeps the output while it runs', () => {
    expect(jobs.start('full')).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].mode).toBe('full');

    spawned[0].child.say('Priors: 17 maps seen\nAnalysed 198 rounds, skipped 0.\n');
    const running = jobs.snapshot();
    expect(running.status).toBe('running');
    expect(running.output).toEqual(['Priors: 17 maps seen', 'Analysed 198 rounds, skipped 0.']);
    expect(running.startedAt).not.toBeNull();
    expect(running.finishedAt).toBeNull();
  });

  it('reports done on a clean exit and failed on a dirty one', () => {
    jobs.start('pending');
    spawned[0].child.finish(0);
    expect(jobs.snapshot()).toMatchObject({ status: 'done', exitCode: 0, mode: 'pending' });

    const second = build();
    second.start('full');
    spawned[1].child.finish(1);
    expect(second.snapshot()).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('keeps stderr too, because that is where a crash explains itself', () => {
    jobs.start('full');
    spawned[0].child.complain('Error: ENOENT\n');
    spawned[0].child.finish(1);
    expect(jobs.snapshot().output).toContain('Error: ENOENT');
  });

  it('refuses a second run while one is in progress, force or not', () => {
    jobs.start('full');
    expect(jobs.start('full')).toEqual({ ok: false, reason: 'A run is already in progress.' });
    expect(jobs.start('full', { force: true }).ok).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it('runs again once the previous run has finished', () => {
    jobs.start('full');
    spawned[0].child.finish(0);
    expect(jobs.start('full')).toEqual({ ok: true });
    expect(spawned).toHaveLength(2);
  });

  // The whole reason the guard exists: this decodes every replay on disk on
  // the same two cores that are holding 100 tick.
  it('refuses while a match is in flight, and says why', () => {
    busy = true;
    const refused = jobs.start('full');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toMatch(/match is in flight/i);
    expect(spawned).toHaveLength(0);
  });

  it('runs anyway when forced', () => {
    busy = true;
    expect(jobs.start('full', { force: true })).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
  });

  // A spawn 'error' is not followed by 'exit'. Without handling it the status
  // would stay 'running' forever and every later start would be refused.
  it('does not wedge on a process that never starts', () => {
    jobs.start('full');
    spawned[0].child.emit('error', new Error('spawn tsx ENOENT'));
    expect(jobs.snapshot().status).toBe('failed');
    expect(jobs.snapshot().output.join(' ')).toMatch(/ENOENT/);
    expect(jobs.start('full')).toEqual({ ok: true });
  });

  it('reports a spawn that throws outright rather than pretending to run', () => {
    const thrower = build({ spawn: () => { throw new Error('no such file'); } });
    const got = thrower.start('full');
    expect(got.ok).toBe(false);
    expect(thrower.snapshot().status).toBe('failed');
  });
});
