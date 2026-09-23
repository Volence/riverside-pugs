import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { recordPhase, roundInProgress } from '../src/liveView.js';
import type { Phase } from '../src/logParse.js';

const TOKEN = 'a'.repeat(32);
let db: DB;
let id: number;

const phase = (state: Phase['state']): Phase => ({ state, team: null, limit: 0, leave: false, unready: [] });

function round(ordinal: number, half: number, ended: boolean): void {
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at, ended_at)
     VALUES (?, ?, ?, 'a', datetime('now', '-5 seconds'), ${ended ? "datetime('now')" : 'NULL'})`,
  ).run(id, ordinal, half);
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`).run(TOKEN);
  id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
});

describe('roundInProgress', () => {
  it('names the newest unended round while the phase is live', () => {
    round(0, 1, true);
    round(0, 2, false);
    recordPhase(db, TOKEN, phase('live'));
    const r = roundInProgress(db, id);
    expect(r).toMatchObject({ ordinal: 0, half: 2 });
    expect(Math.abs(r!.sinceMs - (Date.now() - 5000))).toBeLessThan(3000);
  });

  it('counts a paused round as in progress', () => {
    round(1, 1, false);
    recordPhase(db, TOKEN, phase('paused'));
    expect(roundInProgress(db, id)).toMatchObject({ ordinal: 1, half: 1 });
  });

  it('is null with no phase, between rounds, and once the newest round has ended', () => {
    round(0, 1, false);
    expect(roundInProgress(db, id)).toBeNull();
    recordPhase(db, TOKEN, phase('roundover'));
    expect(roundInProgress(db, id)).toBeNull();
    recordPhase(db, TOKEN, phase('live'));
    db.prepare("UPDATE match_rounds SET ended_at = datetime('now')").run();
    expect(roundInProgress(db, id)).toBeNull();
  });

  // noShow.ts and the lost-dump path in server.ts both abort a match without
  // clearing match_live, on purpose, because every other reader filters on
  // matches.state = 'live'. If roundInProgress trusted the phase alone, a
  // match that died mid-round would report that round as current forever.
  it('is null once the match is aborted, even with a stuck live phase and an unended round', () => {
    round(0, 1, false);
    recordPhase(db, TOKEN, phase('live'));
    expect(roundInProgress(db, id)).toMatchObject({ ordinal: 0, half: 1 });
    db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?").run(id);
    expect(roundInProgress(db, id)).toBeNull();
  });
});
