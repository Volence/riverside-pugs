import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating, currentSeasonId } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { duoBonusMu } from '../src/duoBonus.js';

let db: DB;
const ids = Array.from({ length: 10 }, (_, i) => `765611980000000${String(i).padStart(2, '0')}`);

beforeEach(() => {
  db = openDb(':memory:');
  const season = currentSeasonId(db);
  ids.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: id, avatar: null }, []);
    ensureRating(db, id, season);
    db.prepare('UPDATE player_ratings SET mu = ? WHERE player_id = ? AND season_id = ?').run(20 + i, id, season);
  });
  setSetting(db, 'duo_bonus_min_sr', '50');
  setSetting(db, 'duo_bonus_max_sr', '200');
});

describe('duoBonusMu', () => {
  it('scales from min for the bottom pair to near max for the top pair', () => {
    expect(duoBonusMu(db, ids[0], ids[1])).toBeCloseTo(0.5 + 1.5 * (1 / 10), 5); // avg 20.5: one row below
    expect(duoBonusMu(db, ids[8], ids[9])).toBeCloseTo(0.5 + 1.5 * (9 / 10), 5); // avg 28.5: nine below
  });

  it('a top pair gets more than a bottom pair', () => {
    expect(duoBonusMu(db, ids[8], ids[9])).toBeGreaterThan(duoBonusMu(db, ids[0], ids[1]));
  });

  it('treats max below min as min', () => {
    setSetting(db, 'duo_bonus_max_sr', '10');
    expect(duoBonusMu(db, ids[8], ids[9])).toBeCloseTo(0.5, 5);
  });
});
