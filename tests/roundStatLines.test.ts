import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { recordRoundMark, recordRoundStat, recordRoundStatsEnd, resetRoundLines } from '../src/roundStatLines.js';

const T = 'b'.repeat(32);
function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run(T);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 2, 'b')").run();
  return db;
}

describe('round stat lines', () => {
  it('upserts per-round stats so a duplicate datagram does not double count', () => {
    const db = setup();
    const ev = { kind: 'round_stat' as const, token: T, half: 2 as const, steamid: '76561198000000001', stats: { crowns: 1, w_smg_sidmg: 90 } };
    recordRoundStat(db, 1, ev);
    recordRoundStat(db, 1, ev);
    const rows = db.prepare('SELECT stat, value FROM match_round_stats ORDER BY stat').all();
    expect(rows).toEqual([{ stat: 'crowns', value: 1 }, { stat: 'w_smg_sidmg', value: 90 }]);
  });

  it('records whether skill_detect was loaded on the round', () => {
    const db = setup();
    recordRoundStatsEnd(db, 1, { kind: 'round_stats_end', token: T, half: 2, players: 8, skillDetect: true });
    expect(db.prepare('SELECT skill_detect FROM match_rounds').get()).toEqual({ skill_detect: 1 });
  });

  it('stores markers', () => {
    const db = setup();
    recordRoundMark(db, 1, { kind: 'round_mark', token: T, half: 2, mark: 'panic', tMs: 1234 });
    expect(db.prepare('SELECT ordinal, half, kind, t_ms FROM match_round_marks').all())
      .toEqual([{ ordinal: 0, half: 2, kind: 'panic', t_ms: 1234 }]);
  });

  it('resolves ordinal to the existing round even if currentOrdinal would be higher', () => {
    const db = setup();
    db.prepare('INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (1, ?, 1, 0, 0)').run('map2');
    const ev = { kind: 'round_stat' as const, token: T, half: 2 as const, steamid: '76561198000000001', stats: { crowns: 1 } };
    recordRoundStat(db, 1, ev);
    const rows = db.prepare('SELECT ordinal FROM match_round_stats').all();
    expect(rows).toEqual([{ ordinal: 0 }]);
  });

  it('deletes stale stats and markers from a replayed half', () => {
    const db = setup();
    recordRoundStat(db, 1, { kind: 'round_stat' as const, token: T, half: 2, steamid: '76561198000000001', stats: { crowns: 1 } });
    recordRoundMark(db, 1, { kind: 'round_mark' as const, token: T, half: 2, mark: 'panic', tMs: 1000 });
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    recordRoundStat(db, 1, { kind: 'round_stat' as const, token: T, half: 1, steamid: '76561198000000002', stats: { skeets: 2 } });
    recordRoundMark(db, 1, { kind: 'round_mark' as const, token: T, half: 1, mark: 'finale_start', tMs: 2000 });
    resetRoundLines(db, 1, 0, 2);
    const stats = db.prepare('SELECT half FROM match_round_stats ORDER BY half').all();
    const marks = db.prepare('SELECT half FROM match_round_marks ORDER BY half').all();
    expect(stats).toEqual([{ half: 1 }]);
    expect(marks).toEqual([{ half: 1 }]);
  });
});
