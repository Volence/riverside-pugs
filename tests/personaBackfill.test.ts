import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { backfillPersonas } from '../src/personaBackfill.js';

const OK = (players: any[]) => async () =>
  ({ json: async () => ({ response: { players } }) }) as any;

describe('backfillPersonas', () => {
  it('fills name and avatar for players who have no avatar', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000001', 'dizzy');

    const n = await backfillPersonas(db, 'key', OK([
      { steamid: '76561198000000001', personaname: 'Dizzy', avatarfull: 'http://a/1.jpg' },
    ]));

    expect(n).toBe(1);
    const row = db.prepare('SELECT name, avatar FROM players WHERE steamid = ?').get('76561198000000001') as any;
    expect(row).toEqual({ name: 'Dizzy', avatar: 'http://a/1.jpg' });
  });

  it('leaves players who already have an avatar alone', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name, avatar) VALUES (?, ?, ?)')
      .run('76561198000000002', 'Real Name', 'http://a/2.jpg');
    let called = false;

    const n = await backfillPersonas(db, 'key', (async () => { called = true; return OK([])(); }) as any);

    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it('does nothing without an api key', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000003', 'x');
    expect(await backfillPersonas(db, null, (async () => { throw new Error('must not fetch'); }) as any)).toBe(0);
  });

  it('survives a steam outage without touching any row', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000004', 'nick');

    const n = await backfillPersonas(db, 'key', (async () => { throw new Error('down'); }) as any);

    expect(n).toBe(0);
    expect((db.prepare('SELECT name FROM players WHERE steamid = ?').get('76561198000000004') as any).name)
      .toBe('nick');
  });

  it('skips a steamid steam returns nothing for', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000005', 'ghost');
    expect(await backfillPersonas(db, 'key', OK([]))).toBe(0);
  });

  it('keeps existing nickname when steam response has no personaname but provides avatar', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000006', 'dizzy');

    const n = await backfillPersonas(db, 'key', OK([
      { steamid: '76561198000000006', avatarfull: 'http://a/6.jpg' },
    ]));

    expect(n).toBe(1);
    const row = db.prepare('SELECT name, avatar FROM players WHERE steamid = ?').get('76561198000000006') as any;
    expect(row).toEqual({ name: 'dizzy', avatar: 'http://a/6.jpg' });
  });

  it('leaves player completely untouched when steam response has neither personaname nor avatar', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000007', 'KoRn');

    const n = await backfillPersonas(db, 'key', OK([
      { steamid: '76561198000000007' },
    ]));

    expect(n).toBe(0);
    const row = db.prepare('SELECT name, avatar FROM players WHERE steamid = ?').get('76561198000000007') as any;
    expect(row).toEqual({ name: 'KoRn', avatar: null });
  });
});
