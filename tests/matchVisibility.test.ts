import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { viewerFor, canViewMatch, visibleMatchesSql } from '../src/matchVisibility.js';

let db: DB;
let ids: string[];
let outsider: string;
let mod: string;
let pub: number, priv: number, staffOnly: number;

beforeEach(() => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 10);
  ids = all.slice(0, 8);
  outsider = all[8];
  mod = all[9];
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
  staffOnly = seedMatch(db, { endedAt: '2026-09-21 14:00:00', kind: 'scrim', visibility: 'staff', lines });
});

describe('canViewMatch', () => {
  it.each([
    ['anonymous', (): string | null => null, [true, false, false]],
    ['outsider', (): string => outsider, [true, false, false]],
    ['participant', (): string => ids[0], [true, true, false]],
    ['mod', (): string => mod, [true, true, true]],
  ] as const)('%s', (_label, who, expected) => {
    const v = viewerFor(db, who());
    expect([pub, priv, staffOnly].map((id) => canViewMatch(db, v, id))).toEqual(expected);
  });

  it('a missing match is not viewable', () => {
    expect(canViewMatch(db, viewerFor(db, mod), 999_999)).toBe(false);
  });
});

describe('visibleMatchesSql', () => {
  const idsFor = (who: string | null): number[] => {
    const { sql, params } = visibleMatchesSql(viewerFor(db, who), 'm');
    return (db.prepare(`SELECT m.id FROM matches m WHERE ${sql} ORDER BY m.id`).all(...params) as { id: number }[]).map((r) => r.id);
  };
  it('matches canViewMatch for every viewer', () => {
    expect(idsFor(null)).toEqual([pub]);
    expect(idsFor(outsider)).toEqual([pub]);
    expect(idsFor(ids[0])).toEqual([pub, priv]);
    expect(idsFor(mod)).toEqual([pub, priv, staffOnly]);
  });
});
