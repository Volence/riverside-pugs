import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, setEnabled, type ServerRow } from '../src/serverPool.js';
import { banPlayer, unbanPlayer } from '../src/admin/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { ServerBanSync, banCommand, parseListId, unbanCommand, UNBAN_WINDOW_MS } from '../src/serverBans.js';
import { addAlias } from '../src/aliases.js';

// 76561198030413993 is STEAM_1:1:35074132 (the verified pair).
const P1 = '76561198030413993';
const P2 = '76561197960265730'; // STEAM_1:0:1
// Second accounts merged into P1. A merged alt has no player row.
const ALT1 = '76561197960265732'; // STEAM_1:0:2
const ALT2 = '76561197960265733'; // STEAM_1:1:2
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
  // The engine ban is per SteamID. Banning only the main left every account
  // merged into it free to walk onto the server.
  it('bans every alias of a banned player too, with the same reason', () => {
    addAlias(db, { steamid: ALT1, canonical: P1, by: 'test' });
    addAlias(db, { steamid: ALT2, canonical: P1, by: 'test' });
    banPlayer(db, P1, 'admin', 'Griefing; "twice"', null, new Date(clock));
    expect(sync().commands()).toEqual([
      banCommand(P1, 'Griefing; "twice"'),
      banCommand(ALT1, 'Griefing; "twice"'),
      banCommand(ALT2, 'Griefing; "twice"'),
    ]);
    expect(sync().commands()[1]).toBe('sm_addban 0 "STEAM_1:0:2" "Griefing   twice"');
  });

  it('lifts every alias when the ban is lifted, and none while another ban is open', () => {
    addAlias(db, { steamid: ALT1, canonical: P1, by: 'test' });
    banPlayer(db, P1, 'admin', 'first', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P1, 'admin', new Date(clock - DAY));
    expect(sync().commands()).toEqual([unbanCommand(P1), unbanCommand(ALT1)]);
    banPlayer(db, P1, 'admin', 'second', null, new Date(clock));
    expect(sync().commands()).toEqual([banCommand(P1, 'second'), banCommand(ALT1, 'second')]);
  });

  it('onChange carries the aliases too, both ways', async () => {
    addAlias(db, { steamid: ALT1, canonical: P1, by: 'test' });
    await sync().onChange({ kind: 'ban', steamid: P1, reason: 'Griefing' });
    await sync().onChange({ kind: 'unban', steamid: P1 });
    expect(sent.filter((x) => x.server === 'dallas').map((x) => x.commands)).toEqual([
      [banCommand(P1, 'Griefing'), banCommand(ALT1, 'Griefing')],
      [unbanCommand(P1), unbanCommand(ALT1)],
    ]);
  });

  it('sweep asks each enabled server for its list, skips disabled ones, and sends the full set when the reply is unreadable', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    setEnabled(db, s2, false);
    await sync().sweep();
    expect(sent).toEqual([{ server: 'dallas', commands: ['listid'] }, { server: 'dallas', commands: [banCommand(P1, 'Griefing')] }]);
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
    expect(ran).toEqual(['listid', banCommand(P1, 'Griefing')]);
  });

  it('a failing server neither throws nor stops the others', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const failing = async (server: ServerRow, commands: string[]) => {
      if (server.name === 'dallas') throw new Error('ECONNREFUSED');
      sent.push({ server: server.name, commands });
    };
    await sync({ exec: failing }).sweep();
    expect(sent.map((s) => s.server)).toEqual(['chicago', 'chicago']);
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

// Audit 2026-10-09: the sweep re-sent every ban and every unban of the last
// 30 days every five minutes, and basebans logged each one (26,629 lines on
// Dallas on 10-08). It now reads the box's own list and sends the difference.
describe('diff against the box\'s own list (listid)', () => {
  /** A box: the engine ban list keyed STEAM_1:Y:Z -> 'permanent' | '<n> min'. */
  const box = (initial: Record<string, string> = {}) => {
    const list = new Map(Object.entries(initial));
    const log: string[] = [];
    const answer = (c: string): string => {
      if (c === 'listid') {
        if (list.size === 0) return 'ID filter list: empty\n';
        return `ID filter list: ${list.size} entries\n${[...list].map(([id, t], i) => `${i + 1} ${id} : ${t}`).join('\n')}\n`;
      }
      const add = /^sm_addban 0 "(STEAM_[^"]+)"/.exec(c);
      if (add) { list.set(add[1]!, 'permanent'); log.push(c); return ''; }
      const rm = /^sm_unban "(STEAM_[^"]+)"/.exec(c);
      if (rm) { if (list.delete(rm[1]!)) log.push(c); return ''; }
      return '';
    };
    return { list, log, exec: async (_s: ServerRow, commands: string[]) => commands.map(answer), one: async (c: string) => answer(c) };
  };

  it('parses the engine reply, counting permanent entries only, by account', () => {
    expect(parseListId('ID filter list: empty\n')).toEqual(new Set());
    expect(parseListId('ID filter list: 2 entries\n1 STEAM_1:1:35074132 : permanent\n2 STEAM_0:0:1 : 59.500 min\n'))
      .toEqual(new Set(['1:35074132']));
    expect(parseListId('Unknown command "listid"')).toBeNull();
    expect(parseListId('')).toBeNull();
    expect(parseListId(undefined)).toBeNull();
  });

  it('a box that already holds every ban is told nothing; a second sweep is silent', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    banPlayer(db, P2, 'admin', 'recent', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P2, 'admin', new Date(clock - DAY));
    setEnabled(db, s2, false);
    const b = box({ 'STEAM_1:1:35074132': 'permanent' });
    const calls: string[][] = [];
    const s = sync({ exec: async (sv, c) => { calls.push(c); return b.exec(sv, c); } });
    await s.sweep();
    await s.sweep();
    expect(calls).toEqual([['listid'], ['listid']]);
    expect(b.log).toEqual([]);
  });

  it('pushes a ban the box lacks and an unban it still holds, and nothing else', async () => {
    addAlias(db, { steamid: ALT1, canonical: P1, by: 'test' });
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    banPlayer(db, P2, 'admin', 'old', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P2, 'admin', new Date(clock - DAY));
    setEnabled(db, s2, false);
    // P1 is there, its alt is not, and the lifted P2 still is.
    const b = box({ 'STEAM_1:1:35074132': 'permanent', 'STEAM_1:0:1': 'permanent' });
    await sync({ exec: b.exec }).sweep();
    expect(b.log).toEqual([banCommand(ALT1, 'Griefing'), unbanCommand(P2)]);
    expect([...b.list.keys()].sort()).toEqual(['STEAM_1:0:2', 'STEAM_1:1:35074132']);
  });

  it('a restarted or rebuilt box with an empty list gets every open ban again', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    banPlayer(db, P2, 'system', 'Abandoned match #3', 1440, new Date(clock));
    setEnabled(db, s2, false);
    const b = box();
    await sync({ exec: b.exec }).sweep();
    expect(b.log).toEqual([banCommand(P2, 'Abandoned match #3'), banCommand(P1, 'Griefing')]);
  });

  it('a timed engine ban (an in-game sm_ban) does not stand in for the site\'s permanent one', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    setEnabled(db, s2, false);
    const b = box({ 'STEAM_1:1:35074132': '30.000 min' });
    await sync({ exec: b.exec }).sweep();
    expect(b.log).toEqual([banCommand(P1, 'Griefing')]);
  });

  it('a ban the box holds that the site never made is left alone', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    setEnabled(db, s2, false);
    const b = box({ 'STEAM_1:1:35074132': 'permanent', 'STEAM_1:0:9': 'permanent' });
    await sync({ exec: b.exec }).sweep();
    expect(b.log).toEqual([]);
    expect(b.list.has('STEAM_1:0:9')).toBe(true);
  });

  it('a lift on the site reaches the box through onChange at once, and the sweep after is silent', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock - DAY));
    setEnabled(db, s2, false);
    const b = box({ 'STEAM_1:1:35074132': 'permanent' });
    const s = sync({ exec: b.exec });
    unbanPlayer(db, P1, 'admin', new Date(clock));
    await s.onChange({ kind: 'unban', steamid: P1 });
    expect(b.list.size).toBe(0);
    b.log.length = 0;
    await s.sweep();
    expect(b.log).toEqual([]);
  });

  it('the setup push (pushAll) reads the list on the same connection and sends only the difference', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    banPlayer(db, P2, 'admin', 'Other', null, new Date(clock));
    const b = box({ 'STEAM_1:1:35074132': 'permanent' });
    const ran: string[] = [];
    await sync().pushAll(async (c) => { ran.push(c); return b.one(c); });
    expect(ran).toEqual(['listid', banCommand(P2, 'Other')]);
  });
});
