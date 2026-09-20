import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { banPlayer, unbanPlayer, liftExpiredBans } from '../src/admin/players.js';
import { subscribeBanChanges, type BanChange } from '../src/banEvents.js';

const P = '76561198000000002';
let db: DB;
let seen: BanChange[];
let unsub: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(P, 'p2');
  seen = [];
  unsub?.();
  unsub = subscribeBanChanges((e) => seen.push(e));
});

describe('ban change bus', () => {
  it('banPlayer publishes a ban with its reason', () => {
    banPlayer(db, P, 'admin', 'Griefing', 60);
    expect(seen).toEqual([{ kind: 'ban', steamid: P, reason: 'Griefing' }]);
  });

  it('unbanPlayer publishes an unban', () => {
    banPlayer(db, P, 'admin', 'Griefing', 60);
    unbanPlayer(db, P, 'admin');
    expect(seen.at(-1)).toEqual({ kind: 'unban', steamid: P });
  });

  it('liftExpiredBans publishes an unban once the last ban has run out', () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    banPlayer(db, P, 'system', 'Abandoned match #1', 60, past);
    seen = [];
    liftExpiredBans(db);
    expect(seen).toEqual([{ kind: 'unban', steamid: P }]);
  });

  it('liftExpiredBans stays quiet while another ban is still open', () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    banPlayer(db, P, 'system', 'Abandoned match #1', 60, past);
    banPlayer(db, P, 'admin', 'Griefing', null);
    seen = [];
    liftExpiredBans(db);
    expect(seen).toEqual([]);
  });

  it('a throwing subscriber does not stop publishing', () => {
    subscribeBanChanges(() => { throw new Error('boom'); });
    banPlayer(db, P, 'admin', 'Griefing', 60);
    expect(seen).toHaveLength(1);
  });
});
