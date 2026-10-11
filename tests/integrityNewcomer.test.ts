import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';
import { claimNewcomerPosts, flagNewcomers, newcomerOutliers, NEWCOMER_KIND } from '../src/integrity/newcomer.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

/** A round with line of sight whose hidden occupancy is `observed` against an
 *  expectation of 1. */
const metrics = (observed: number) => JSON.stringify({
  fidMax: 0, fidP95: 0, windows: 0, scoreable: 0, fidSum: 0, eligiblePairs: 100, losKnown: true,
  occ: { observed: 1, expected: 1, expectedSq: 0.05, blocks: 20, pairs: 100 },
  gates: { considered: 400, notLive: 20, notGhost: 100, inGrace: 50, tooClose: 30, occluded: 100, passed: 100 },
  hidden: {
    windows: 0, scoreable: 0, fidSum: 0, fidMax: 0, reveals: 10, revealOn: 2,
    occ: { observed, expected: 1, expectedSq: 0.05, blocks: 20, pairs: 100 },
    byClass: Object.fromEntries(['hunter', 'smoker', 'boomer'].map((c) => [c, { scoreable: 0, fidSum: 0, occ: null, reveals: 0, revealOn: 0 }])),
    gates: { considered: 0, notLive: 0, notTarget: 0, inGrace: 0, tooClose: 0, losUnknown: 0, seen: 0, teamSees: 0, occluded: 0, passed: 0 },
  },
});

let slot = 0;
/** One player's rounds in one match. */
function play(matchId: number, steamid: string, observed: number[], ended = '2026-10-10 21:48:22'): void {
  db.prepare("INSERT OR IGNORE INTO matches (id, season_id, state, campaign, ended_at) VALUES (?, 1, 'completed', 'farm', ?)").run(matchId, ended);
  const ins = db.prepare(
    `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, datetime('now'))`,
  );
  const s = slot++ % 8;
  observed.forEach((o, i) => ins.run(matchId, i, s, steamid, ANALYZER_VERSION, metrics(o)));
}

/** 100 honest regulars, two matches each (so the board ranks them), spread
 *  a little either side of expected. */
function honest(): void {
  for (let i = 0; i < 200; i++) {
    const o = 1 + 0.25 * Math.sin(i * 1.7);
    play(1000 + i, `7656119800000${String(i >> 1).padStart(4, '0')}`, [o, o, o, o]);
  }
}

describe('newcomer outliers', () => {
  it('flags a one-match account in the top 1%', () => {
    honest();
    play(631, 'NEW', [3, 3.5, 2.5, 3]);
    const out = newcomerOutliers(db);
    expect(out.map((o) => [o.steamid, o.matchId])).toEqual([['NEW', 631]]);
    expect(out[0].rank).toBe(1);
    expect(out[0].totalRounds).toBe(4);
  });

  // The board ranks a player with eight rounds, so this is not asked of them.
  it('leaves a player the board already ranks', () => {
    honest();
    play(700, 'VET', [1, 1, 1, 1]);
    play(701, 'VET', [3, 3.5, 2.5, 3]);
    expect(newcomerOutliers(db)).toEqual([]);
  });

  it('needs four rounds with line of sight in the match', () => {
    honest();
    play(631, 'NEW', [3, 3.5, 2.5]);
    expect(newcomerOutliers(db)).toEqual([]);
  });

  it('flags once however often it runs', () => {
    honest();
    play(631, 'NEW', [3, 3.5, 2.5, 3]);
    expect(flagNewcomers(db)).toHaveLength(1);
    expect(flagNewcomers(db)).toHaveLength(0);
    const rows = db.prepare('SELECT source, kind, severity, detail FROM integrity_flags').all() as { source: string; kind: string; severity: string; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'analyzer', kind: NEWCOMER_KIND, severity: 'suspected' });
    expect(rows[0].detail).toMatch(/#1 of 201 matches on record; 4 scored rounds in total/);
  });
});

describe('claimNewcomerPosts', () => {
  const now = new Date('2026-10-10T23:00:00Z');

  it('hands each flag out once', () => {
    honest();
    play(631, 'NEW', [3, 3.5, 2.5, 3]);
    flagNewcomers(db, now);
    expect(claimNewcomerPosts(db, now).map((f) => f.matchId)).toEqual([631]);
    expect(claimNewcomerPosts(db, now)).toEqual([]);
  });

  // The first run flags all of history; old matches stay on the file and are
  // not posted as if they were news.
  it('does not post a flag on an old match', () => {
    honest();
    play(400, 'OLD', [3, 3.5, 2.5, 3], '2026-09-20 21:00:00');
    flagNewcomers(db, now);
    expect(claimNewcomerPosts(db, now)).toEqual([]);
    expect(claimNewcomerPosts(db, now)).toEqual([]);
  });
});
