import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('stores the health curve as its 21 values and the tank window as two columns', () => {
    const id = seedLive();
    const curve = [100, 100, 100, 100, 89, 89, 89, 89, 89, 89, 89, 89, 89, 89, ...Array(7).fill(-1)];
    recordAltRound(db, TOKEN, event({ curve, tankOpen: 42, tankClose: 63 }));
    expect(rows(id)[0]).toMatchObject({
      curve: '100,100,100,100,89,89,89,89,89,89,89,89,89,89,-1,-1,-1,-1,-1,-1,-1', tank_open: 42, tank_close: 63, source: 'udp',
    });
  });

  it('a line without the curve (older plugins) stores NULLs, as does a record built before the fields existed', () => {
    const id = seedLive();
    recordAltRound(db, TOKEN, event({ curve: null, tankOpen: null, tankClose: null }));
    expect(rows(id)[0]).toMatchObject({ curve: null, tank_open: null, tank_close: null, walk: 463 });
    const { curve: _c, tankOpen: _o, tankClose: _cl, ...old } = event({ half: 1 });
    recordAltRound(db, TOKEN, old);
    expect(rows(id)[0]).toMatchObject({ half: 1, curve: null, tank_open: null, tank_close: null });
  });

  it('a dump row replaces the curve too; a later UDP line cannot change it', () => {
    const id = seedLive();
    recordAltRound(db, TOKEN, event({ curve: Array(21).fill(50), tankOpen: 10, tankClose: 20 }));
    const { kind: _k, token: _t, ...fields } = event({ curve: Array(21).fill(60), tankOpen: 11, tankClose: 21 });
    upsertAltRound(db, id, 0, fields, 'dump');
    recordAltRound(db, TOKEN, event({ curve: Array(21).fill(70), tankOpen: 12, tankClose: 22 }));
    expect(rows(id)[0]).toMatchObject({ curve: Array(21).fill(60).join(','), tank_open: 11, tank_close: 21, source: 'dump' });
  });

  it('adds the curve columns to a match_round_alt made before them, keeping its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'altcurve-'));
    try {
      const path = join(dir, 'pug.db');
      const before = openDb(path);
      for (const c of ['curve', 'tank_open', 'tank_close']) before.exec(`ALTER TABLE match_round_alt DROP COLUMN ${c}`);
      const id = Number(before.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'airport', ?)").run(TOKEN).lastInsertRowid);
      before.exec(`INSERT INTO match_round_alt (match_id, ordinal, half, rule, surv_team, walk, tank, door, walk_mult, door_mult,
        ws, wt, wr, ts, tt, tr, ds, dt, dr, tank_pct, tank_by, tanks, survivors_in, source)
        VALUES (${id}, 0, 1, 'hr1', 'a', 1, 2, 3, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, 4, 'dump')`);
      expect((before.prepare('PRAGMA table_info(match_round_alt)').all() as { name: string }[]).map((c) => c.name)).not.toContain('curve');
      before.close();
      const after = openDb(path);
      const cols = (after.prepare('PRAGMA table_info(match_round_alt)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['curve', 'tank_open', 'tank_close']));
      expect(after.prepare('SELECT walk, curve, tank_open, tank_close FROM match_round_alt').all()).toEqual([
        { walk: 1, curve: null, tank_open: null, tank_close: null },
      ]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unknown token writes nothing and does not throw', () => {
    const id = seedLive();
    expect(() => recordAltRound(db, 'f'.repeat(32), event({ token: 'f'.repeat(32) }))).not.toThrow();
    expect(rows(id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_round_alt').get()).toEqual({ n: 0 });
  });
});
