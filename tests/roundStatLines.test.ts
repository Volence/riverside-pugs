import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { recordRoundMark, recordRoundStat, recordRoundStatsEnd } from '../src/roundStatLines.js';

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
});
