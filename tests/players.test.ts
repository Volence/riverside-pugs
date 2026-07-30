import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  upsertPlayer, getPlayer, activatePlayer, currentSeasonId, ensureRating, getRatings,
} from '../src/players.js';

const P1 = '76561198000000001';
const ADMIN = '76561198000000009';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('upsertPlayer', () => {
  it('creates new players as invited', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    const p = getPlayer(db, P1)!;
    expect(p.status).toBe('invited');
    expect(p.is_admin).toBe(0);
    expect(p.name).toBe('alice');
  });

  it('creates admins as active with admin flag', () => {
    upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, [ADMIN]);
    const p = getPlayer(db, ADMIN)!;
    expect(p.status).toBe('active');
    expect(p.is_admin).toBe(1);
  });

  it('updates name/avatar on re-login without touching status', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    activatePlayer(db, P1);
    upsertPlayer(db, { steamid: P1, name: 'alice2', avatar: 'x.jpg' }, []);
    const p = getPlayer(db, P1)!;
    expect(p.name).toBe('alice2');
    expect(p.avatar).toBe('x.jpg');
    expect(p.status).toBe('active');
  });

  it('promotes an existing player when they become admin', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, [P1]);
    const p = getPlayer(db, P1)!;
    expect(p.status).toBe('active');
    expect(p.is_admin).toBe(1);
  });
});

describe('ratings', () => {
  it('ensureRating creates default openskill rating for current season', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    const r = ensureRating(db, P1);
    expect(r.season_id).toBe(currentSeasonId(db));
    expect(r.mu).toBeCloseTo(25);
    expect(r.sigma).toBeCloseTo(25 / 3);
    expect(ensureRating(db, P1)).toEqual(r); // idempotent
  });

  it('getRatings returns a map for multiple players', () => {
    upsertPlayer(db, { steamid: P1, name: 'a', avatar: null }, []);
    upsertPlayer(db, { steamid: ADMIN, name: 'b', avatar: null }, []);
    ensureRating(db, P1);
    ensureRating(db, ADMIN);
    const m = getRatings(db, [P1, ADMIN]);
    expect(m.size).toBe(2);
    expect(m.get(P1)!.mu).toBeCloseTo(25);
  });
});
