import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import {
  recordMatchStart, recordMapResult, recordLiveStat, recordRoundStart, recordRoundEnd, recordHeartbeat,
} from '../src/liveView.js';
import { archiveAborted } from '../src/matchArchive.js';

const TOKEN = 'b'.repeat(32);
const A = ['76561198000000001', '76561198000000002'];
const B = ['76561198000000003', '76561198000000004'];
const MAP0 = 'l4d_vs_hospital01_apartment';
const MAP1 = 'l4d_vs_hospital02_subway';

let db: DB;
let matchId: number;

function seed(): number {
  for (const id of [...A, ...B]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)",
  ).run(TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  for (const p of A) ins.run(id, p, 'a');
  for (const p of B) ins.run(id, p, 'b');
  return id;
}

/** One map played out: loaded, both halves, then its MAP_RESULT. The ordinal
 *  is not passed because nothing on the wire carries one: recordRoundStart
 *  derives it from how many maps have already been closed. */
function playMap(map: string, aScore: number, bScore: number): void {
  recordMatchStart(db, TOKEN, map);
  recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, half: 1, map, surv: 'a' });
  recordRoundEnd(db, TOKEN, { kind: 'round_end', token: TOKEN, half: 1, map, surv: 'a', score: aScore, alive: 4 });
  recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, half: 2, map, surv: 'b' });
  recordRoundEnd(db, TOKEN, { kind: 'round_end', token: TOKEN, half: 2, map, surv: 'b', score: bScore, alive: 4 });
  recordMapResult(db, TOKEN, map, aScore, bScore);
}

const mapsOf = () => db.prepare(
  'SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_maps WHERE match_id = ? ORDER BY ordinal',
).all(matchId);

beforeEach(() => {
  db = openDb(':memory:');
  matchId = seed();
});

describe('archiveAborted', () => {
  it('promotes the played maps into match_maps and totals the scoreline', () => {
    playMap(MAP0, 100, 50);
    playMap(MAP1, 40, 80);

    archiveAborted(db, matchId);

    expect(mapsOf()).toEqual([
      { ordinal: 0, map: MAP0, a: 100, b: 50 },
      { ordinal: 1, map: MAP1, a: 40, b: 80 },
    ]);
    // How far they got. `winner` stays null: that, not the rows, is what says
    // no result was reached, and it is what keeps this out of every aggregate.
    expect(db.prepare('SELECT team_a_score AS a, team_b_score AS b, winner FROM matches WHERE id = ?').get(matchId))
      .toEqual({ a: 140, b: 130, winner: null });
  });

  it('keeps the map the abort interrupted, which is the one an admin wants', () => {
    playMap(MAP0, 100, 50);
    // Half two of map 1 never ended: this is the moment someone walked.
    recordMatchStart(db, TOKEN, MAP1);
    recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, half: 1, map: MAP1, surv: 'a' });
    recordRoundEnd(db, TOKEN, { kind: 'round_end', token: TOKEN, half: 1, map: MAP1, surv: 'a', score: 60, alive: 3 });
    recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, half: 2, map: MAP1, surv: 'b' });

    archiveAborted(db, matchId);

    expect(mapsOf()).toEqual([
      { ordinal: 0, map: MAP0, a: 100, b: 50 },
      // Team b's half never ended, so it contributes nothing rather than the
      // column default read as "they scored zero".
      { ordinal: 1, map: MAP1, a: 60, b: 0 },
    ]);
  });

  it('names the interrupted map from the live scratch when no round reached it', () => {
    playMap(MAP0, 100, 50);
    recordMatchStart(db, TOKEN, MAP1);

    archiveAborted(db, matchId);

    expect(mapsOf()).toEqual([
      { ordinal: 0, map: MAP0, a: 100, b: 50 },
      { ordinal: 1, map: MAP1, a: 0, b: 0 },
    ]);
  });

  it('freezes the running per-player totals onto the roster rows', () => {
    recordLiveStat(db, TOKEN, A[0], { ck: 120, sidmg: 900, sikill: 7, ff: 3, rev: 2, skeets: 4 });
    playMap(MAP0, 100, 50);

    archiveAborted(db, matchId);

    expect(db.prepare(
      'SELECT common_kills AS ck, si_damage AS sidmg, si_kills AS sikill, ff_dealt AS ff, revives AS rev FROM match_players WHERE match_id = ? AND player_id = ?',
    ).get(matchId, A[0])).toEqual({ ck: 120, sidmg: 900, sikill: 7, ff: 3, rev: 2 });
    // Registry stats go where the match page reads them from.
    expect(db.prepare(
      'SELECT value FROM match_player_stats WHERE match_id = ? AND player_id = ? AND stat = ?',
    ).get(matchId, A[0], 'skeets')).toEqual({ value: 4 });
  });

  it('drops the scratch once it has been promoted', () => {
    recordLiveStat(db, TOKEN, A[0], { ck: 5 });
    playMap(MAP0, 100, 50);

    archiveAborted(db, matchId);

    for (const t of ['match_live', 'match_live_players', 'match_live_maps']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    }
  });

  it('is re-runnable and never overwrites what is already there', () => {
    playMap(MAP0, 100, 50);
    archiveAborted(db, matchId);
    const before = mapsOf();

    archiveAborted(db, matchId);

    expect(mapsOf()).toEqual(before);
    expect(db.prepare('SELECT team_a_score AS a, team_b_score AS b FROM matches WHERE id = ?').get(matchId))
      .toEqual({ a: 100, b: 50 });
  });

  it('backfills a match whose scratch was already cleared, off the demo rows', () => {
    recordLiveStat(db, TOKEN, A[0], { ck: 77 });
    playMap(MAP0, 100, 50);
    // The pre-archive behaviour: clearLive ran and took everything with it.
    db.prepare('DELETE FROM match_live WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live_maps WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live_players WHERE match_id = ?').run(matchId);
    db.prepare(
      'INSERT INTO match_demos (match_id, ordinal, map, filename, bytes) VALUES (?, 0, ?, ?, 1)',
    ).run(matchId, MAP0, 'x.dem');

    archiveAborted(db, matchId);

    expect(mapsOf()).toEqual([{ ordinal: 0, map: MAP0, a: 100, b: 50 }]);
    // match_live_map_stats survives clearLive, so the totals as of the last
    // map that ENDED are still recoverable.
    expect(db.prepare('SELECT common_kills AS ck FROM match_players WHERE match_id = ? AND player_id = ?')
      .get(matchId, A[0])).toEqual({ ck: 77 });
  });

  it('leaves a voided match alone: it completed, and its result is real', () => {
    playMap(MAP0, 100, 50);
    db.prepare("UPDATE matches SET state = 'completed', team_a_score = 100, team_b_score = 50, winner = 'a' WHERE id = ?")
      .run(matchId);
    db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, ?, 100, 50)')
      .run(matchId, MAP0);

    archiveAborted(db, matchId);

    expect(db.prepare('SELECT team_a_score AS a, team_b_score AS b, winner FROM matches WHERE id = ?').get(matchId))
      .toEqual({ a: 100, b: 50, winner: 'a' });
    expect(mapsOf()).toEqual([{ ordinal: 0, map: MAP0, a: 100, b: 50 }]);
  });
});
