import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, setEnabled, type ServerRow } from '../src/serverPool.js';
import { banPlayer, unbanPlayer } from '../src/admin/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { ServerBanSync, banCommand, unbanCommand, UNBAN_WINDOW_MS } from '../src/serverBans.js';

// 76561198030413993 is STEAM_1:1:35074132 (the verified pair).
const P1 = '76561198030413993';
const P2 = '76561197960265730'; // STEAM_1:0:1
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let db: DB;
let sent: { server: string; commands: string[] }[];
let clock: number;
let s1: number;
let s2: number;

const exec = async (server: ServerRow, commands: string[]) => { sent.push({ server: server.name, commands }); };
const sync = (over: Partial<ConstructorParameters<typeof ServerBanSync>[0]> = {}) =>
  new ServerBanSync({ db, exec, now: () => clock, ...over });

beforeEach(() => {
  db = openDb(':memory:');
  for (const p of [P1, P2]) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(p, p);
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  sent = [];
  clock = Date.parse('2026-09-19T12:00:00Z');
});

describe('command text', () => {
  it('bans permanently, in STEAM_1 form, with a quoted reason', () => {
    expect(banCommand(P1, 'Abandoned match #12')).toBe('sm_addban 0 "STEAM_1:1:35074132" "Abandoned match #12"');
    expect(unbanCommand(P1)).toBe('sm_unban "STEAM_1:1:35074132"');
  });

  it('strips characters that would end the argument or the command', () => {
    expect(banCommand(P2, 'he said "hi"; rcon_password x')).toBe('sm_addban 0 "STEAM_1:0:1" "he said  hi   rcon_password x"');
  });

  it('never sends an empty reason', () => {
    expect(banCommand(P2, '"')).toBe('sm_addban 0 "STEAM_1:0:1" "banned"');
  });
});

describe('ServerBanSync.commands', () => {
  it('lists every open ban and no lifted one', () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    banPlayer(db, P2, 'system', 'Abandoned match #3', 1440, new Date(clock));
    expect(sync().commands()).toEqual([
      banCommand(P2, 'Abandoned match #3'),
      banCommand(P1, 'Griefing'),
    ]);
  });

  it('uses the newest reason when a player has several open bans', () => {
    banPlayer(db, P1, 'admin', 'first', null, new Date(clock - HOUR));
    banPlayer(db, P1, 'admin', 'second', null, new Date(clock));
    expect(sync().commands()).toEqual([banCommand(P1, 'second')]);
  });

  it('treats an expired ban as not open', () => {
    banPlayer(db, P1, 'system', 'Abandoned match #3', 60, new Date(clock - 2 * HOUR));
    expect(sync().commands()).toEqual([]);
  });

  it('unbans anyone lifted inside the window and nobody outside it', () => {
    banPlayer(db, P1, 'admin', 'old', null, new Date(clock - 40 * DAY));
    unbanPlayer(db, P1, 'admin', new Date(clock - 31 * DAY));
    banPlayer(db, P2, 'admin', 'recent', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P2, 'admin', new Date(clock - DAY));
    expect(UNBAN_WINDOW_MS).toBe(30 * DAY);
    expect(sync().commands()).toEqual([unbanCommand(P2)]);
  });

  it('never unbans a player who still has an open ban', () => {
    banPlayer(db, P1, 'admin', 'old', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P1, 'admin', new Date(clock - DAY));
    banPlayer(db, P1, 'admin', 'again', null, new Date(clock));
    expect(sync().commands()).toEqual([banCommand(P1, 'again')]);
  });
});

describe('ServerBanSync pushing', () => {
  it('sweep sends the full command set to every enabled server and skips disabled ones', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    setEnabled(db, s2, false);
    await sync().sweep();
    expect(sent).toEqual([{ server: 'dallas', commands: [banCommand(P1, 'Griefing')] }]);
  });

  it('sweep sends nothing when there is nothing to say', async () => {
    await sync().sweep();
    expect(sent).toEqual([]);
  });

  it('onChange pushes just that change to every enabled server', async () => {
    await sync().onChange({ kind: 'ban', steamid: P1, reason: 'Griefing' });
    await sync().onChange({ kind: 'unban', steamid: P2 });
    expect(sent.map((s) => s.server)).toEqual(['dallas', 'chicago', 'dallas', 'chicago']);
    expect(sent[0].commands).toEqual([banCommand(P1, 'Griefing')]);
    expect(sent[2].commands).toEqual([unbanCommand(P2)]);
  });

  it('pushAll runs every command through a caller-supplied exec', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const ran: string[] = [];
    await sync().pushAll(async (c) => { ran.push(c); });
    expect(ran).toEqual([banCommand(P1, 'Griefing')]);
  });

  it('a failing server neither throws nor stops the others', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const failing = async (server: ServerRow, commands: string[]) => {
      if (server.name === 'dallas') throw new Error('ECONNREFUSED');
      sent.push({ server: server.name, commands });
    };
    await sync({ exec: failing }).sweep();
    expect(sent.map((s) => s.server)).toEqual(['chicago']);
  });

  it('reports a failing server to the admin feed at most once an hour', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const events: AdminEvent[] = [];
    const unsub = subscribeAdminEvents((e) => events.push(e));
    const failing = async () => { throw new Error('ECONNREFUSED'); };
    const s = sync({ exec: failing });
    await s.sweep();
    await s.sweep();
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(2); // one per server
    clock += 61 * 60 * 1000;
    await s.sweep();
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(4);
    expect(events.some((e) => e.kind === 'problem' && /Could not push bans to dallas/.test(e.text))).toBe(true);
    unsub();
  });
});
