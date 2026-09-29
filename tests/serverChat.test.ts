import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import {
  _resetNames, listLines, markDelivered, noteName, recordSay, recordStaffIn, recordStaffOut,
} from '../src/serverChat.js';

const P = '76561199048276493';
const MOD = '76561199000000009';
const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);
let db: DB;
let s1: number;
let s2: number;

beforeEach(() => {
  db = openDb(':memory:');
  _resetNames();
  s1 = server(db, 'Dallas');
  s2 = server(db, 'Chicago');
});

describe('server_chat store', () => {
  it('stores a say line with the in-game name last seen, and lists it', () => {
    noteName(P, 'Zoey Main');
    recordSay(db, s1, { steamid: P, team: 2, scope: 'team', message: 'rush' }, 1000);
    const [row] = listLines(db, s1, 0, 200);
    expect(row).toMatchObject({ server_id: s1, at: 1000, steamid: P, name: 'Zoey Main', team: 2, scope: 'team', kind: 'say', message: 'rush', match_id: null });
  });

  it('falls back to the site name, then null', () => {
    upsertPlayer(db, { steamid: P, name: 'Site Name', avatar: null }, []);
    recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'a' });
    recordSay(db, s1, { steamid: '76561199000000001', team: 3, scope: null, message: 'b' });
    const rows = listLines(db, s1, 0, 200);
    expect(rows.map((r) => r.name)).toEqual(['Site Name', null]);
  });

  it('keeps servers apart and pages with after', () => {
    const a = recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'one' });
    recordSay(db, s2, { steamid: P, team: 2, scope: null, message: 'other server' });
    recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'two' });
    expect(listLines(db, s1, 0, 200).map((r) => r.message)).toEqual(['one', 'two']);
    expect(listLines(db, s1, a, 200).map((r) => r.message)).toEqual(['two']);
  });

  it('with after = 0 returns the newest limit lines, oldest first', () => {
    for (let i = 0; i < 5; i++) recordSay(db, s1, { steamid: P, team: 2, scope: null, message: `m${i}` });
    expect(listLines(db, s1, 0, 3).map((r) => r.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('records a /staff message and a staff send', () => {
    recordStaffIn(db, s1, { steamid: P, team: 3, message: 'help' });
    const id = recordStaffOut(db, s1, { sentBy: MOD, name: 'Volence', toKind: 'player', toValue: P, message: 'on it' });
    const rows = listLines(db, s1, 0, 200);
    expect(rows[0]).toMatchObject({ kind: 'staff_in', steamid: P, message: 'help' });
    expect(rows[1]).toMatchObject({ id, kind: 'staff_out', steamid: null, name: 'Volence', sent_by: MOD, to_kind: 'player', to_value: P, delivered: null });
  });

  it('marks delivery only for the server that was sent to', () => {
    const id = recordStaffOut(db, s1, { sentBy: MOD, name: 'V', toKind: 'all', toValue: null, message: 'hi' });
    expect(markDelivered(db, s2, id, 8)).toBe(false);
    expect(markDelivered(db, s1, id, 4)).toBe(true);
    expect(listLines(db, s1, 0, 200)[0].delivered).toBe(4);
  });

  it('never marks delivery on a player line', () => {
    const id = recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'x' });
    expect(markDelivered(db, s1, id, 3)).toBe(false);
  });

  it('tags the live match on that server', () => {
    const m = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id) VALUES (1, 'live', 'no_mercy', ?)").run(s1).lastInsertRowid);
    recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'x' });
    expect(listLines(db, s1, 0, 200)[0].match_id).toBe(m);
  });
});
