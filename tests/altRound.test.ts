import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { recordAltRound, type AltRoundEvent } from '../src/liveView.js';
import { upsertAltRound } from '../src/altRoundStore.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

let db: DB;

function seedLive(): number {
  return Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'airport', ?)")
      .run(TOKEN).lastInsertRowid,
  );
}

function event(over: Partial<AltRoundEvent> = {}): AltRoundEvent {
  return {
    kind: 'alt_round', token: TOKEN, map: 'l4d_vs_airport03_garage', half: 2, surv: 'b', rule: 'hr1',
    walk: 463, tank: 164, door: 0, walkMult: 1.15, doorMult: 1.75,
    raw: { ws: 180.25, wt: 40.5, wr: 96, ts: 150, tt: 60, tr: 90, ds: 0, dt: 0, dr: 0 },
    tankPct: 41, tankBy: 'surv', tanks: 1, survivorsIn: 0,
    ...over,
  };
}

function rows(matchId: number) {
  return db.prepare('SELECT * FROM match_round_alt WHERE match_id = ? ORDER BY ordinal, half').all(matchId) as Record<string, unknown>[];
}

beforeEach(() => { db = openDb(':memory:'); });

describe('match_round_alt', () => {
  it('stores a UDP ALT_ROUND as one row', () => {
    const id = seedLive();
    recordAltRound(db, TOKEN, event());
    expect(rows(id)).toEqual([expect.objectContaining({
      match_id: id, ordinal: 0, half: 2, rule: 'hr1', surv_team: 'b',
      walk: 463, tank: 164, door: 0, walk_mult: 1.15, door_mult: 1.75,
      ws: 180.25, wt: 40.5, wr: 96, ts: 150, tt: 60, tr: 90, ds: 0, dt: 0, dr: 0,
      tank_pct: 41, tank_by: 'surv', tanks: 1, survivors_in: 0, source: 'udp',
    })]);
  });

  it('stores no tank window as nulls', () => {
    const id = seedLive();
    recordAltRound(db, TOKEN, event({ tankPct: null, tankBy: null, tanks: 0 }));
    expect(rows(id)[0]).toMatchObject({ tank_pct: null, tank_by: null, tanks: 0 });
  });

  it('a second UDP line for the same half updates the row', () => {
    const id = seedLive();
    recordAltRound(db, TOKEN, event());
    recordAltRound(db, TOKEN, event({ walk: 500, survivorsIn: 2 }));
    const r = rows(id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ walk: 500, survivors_in: 2, source: 'udp' });
  });

  it('a UDP line never overwrites a dump row; a dump always replaces', () => {
    const id = seedLive();
    recordAltRound(db, TOKEN, event());
    const { kind: _k, token: _t, ...fields } = event({ walk: 400 });
    upsertAltRound(db, id, 0, fields, 'dump');
    expect(rows(id)[0]).toMatchObject({ walk: 400, source: 'dump' });
    recordAltRound(db, TOKEN, event({ walk: 999 }));
    expect(rows(id)[0]).toMatchObject({ walk: 400, source: 'dump' });
    upsertAltRound(db, id, 0, { ...fields, walk: 410 }, 'dump');
    expect(rows(id)[0]).toMatchObject({ walk: 410, source: 'dump' });
  });

  it('an unknown token writes nothing and does not throw', () => {
    const id = seedLive();
    expect(() => recordAltRound(db, 'f'.repeat(32), event({ token: 'f'.repeat(32) }))).not.toThrow();
    expect(rows(id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_round_alt').get()).toEqual({ n: 0 });
  });
});
