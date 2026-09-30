import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { completedPug } from '../src/matchKinds.js';
import { applyMatchRatings, recomputeSeasonRatings } from '../src/rating.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

function eightLines(ids: string[]) {
  return ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
}
function withMap(db: ReturnType<typeof openDb>, id: number) {
  db.prepare("INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 1, 'm1', 500, 400)").run(id);
}

describe('completedPug', () => {
  it('builds the fragment with and without an alias', () => {
    expect(completedPug('m')).toBe("m.state = 'completed' AND m.kind = 'pug'");
    expect(completedPug()).toBe("state = 'completed' AND kind = 'pug'");
  });
});

describe('SR only moves on PUGs', () => {
  it('applyMatchRatings refuses a scrim or a tournament match', () => {
    const db = openDb(':memory:');
    const ids = seedPlayers(db, 8);
    for (const kind of ['scrim', 'tournament'] as const) {
      const id = seedMatch(db, { endedAt: '2026-09-20 12:00:00', kind, visibility: kind === 'scrim' ? 'participants' : 'public', lines: eightLines(ids) });
      withMap(db, id);
      expect(applyMatchRatings(db, id)).toMatchObject({ applied: false, reason: 'not_pug' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ?').get(id)).toEqual({ n: 0 });
    }
  });

  it('recomputeSeasonRatings ignores scrims and reproduces PUG ratings', () => {
    const db = openDb(':memory:');
    const ids = seedPlayers(db, 8);
    const pug = seedMatch(db, { endedAt: '2026-09-20 12:00:00', lines: eightLines(ids) });
    withMap(db, pug);
    applyMatchRatings(db, pug);
    const before = db.prepare('SELECT player_id, mu, sigma, wins, losses FROM player_ratings ORDER BY player_id').all();
    const scrim = seedMatch(db, { endedAt: '2026-09-20 13:00:00', kind: 'scrim', visibility: 'participants', winner: 'b', lines: eightLines(ids) });
    withMap(db, scrim);
    recomputeSeasonRatings(db, 1);
    expect(db.prepare('SELECT player_id, mu, sigma, wins, losses FROM player_ratings ORDER BY player_id').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ?').get(scrim)).toEqual({ n: 0 });
  });
});
