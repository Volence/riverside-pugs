import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating } from '../src/players.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { recordSiKill } from '../src/aimRules.js';

const P = '76561198129925325';
const ALT = '76561199861598482';
let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, ALT]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  for (const id of [P, ALT]) ensureRating(db, id);
});

describe('recordSiKill', () => {
  it('stores the kill as the spec\'s columns', () => {
    const id = recordSiKill(db, {
      matchId: 722, serverId: 1, steamid: P, weapon: 'smg', headshot: true, dist: 612, pre: 143.5, back: -1, victimClass: 'hunter',
    }, new Date('2026-10-17T21:04:13.000Z'));
    expect(db.prepare('SELECT * FROM si_kills WHERE id = ?').get(id)).toEqual({
      id, match_id: 722, server_id: 1, steamid: P, weapon: 'smg', headshot: 1, dist: 612,
      pre: 143.5, back: -1, victim_class: 'hunter', at: '2026-10-17T21:04:13.000Z',
    });
  });

  it('moves with a merged alt', () => {
    recordSiKill(db, { matchId: 722, serverId: 1, steamid: ALT, weapon: 'smg', headshot: false, dist: 300, pre: 5, back: 2, victimClass: 'smoker' });
    mergePlayers(db, { from: ALT, into: P });
    expect(db.prepare('SELECT steamid FROM si_kills').all()).toEqual([{ steamid: P }]);
  });
});
