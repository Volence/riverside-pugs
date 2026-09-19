import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { addServer } from '../src/serverPool.js';
import { parseLogDatagram } from '../src/logParse.js';
import { handleAbandon, abandonBanMinutes, statusShowsAbandoner } from '../src/abandon.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { activeBan } from '../src/admin/players.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const TOKEN = 'a'.repeat(32);
let db: DB;
let released: number[];
let matchId: number;
let serverId: number;

function liveMatch(token = TOKEN): number {
  const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, ?)").run(serverId, token).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  db.prepare("INSERT OR REPLACE INTO match_live (match_id, last_seen) VALUES (?, datetime('now'))").run(id);
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  for (const p of IDS) { upsertPlayer(db, { steamid: p, name: `p${p.slice(-1)}`, avatar: null }, []); activatePlayer(db, p); }
  serverId = addServer(db, { name: 's', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  released = [];
  matchId = liveMatch();
});

const deps = (confirm = true) => ({
  db,
  releaser: { release: (id: number) => void released.push(id) } as never,
  confirm: async () => confirm,
});

describe('ABANDON line', () => {
  it('parses LEAVE, RETURN and ABANDON', () => {
    const f = (l: string) => Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/17/2026 - 20:00:00: ${l}\n\0`)]);
    expect(parseLogDatagram(f(`PUG ${TOKEN} ABANDON steamid=${IDS[2]}`))).toEqual({ kind: 'abandon', token: TOKEN, steamid: IDS[2] });
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${IDS[2]} remaining=254`))).toEqual({ kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 254 });
    expect(parseLogDatagram(f(`PUG ${TOKEN} RETURN steamid=${IDS[2]} remaining=200`))).toEqual({ kind: 'return', token: TOKEN, steamid: IDS[2], remaining: 200 });
    expect(parseLogDatagram(f(`PUG ${TOKEN} ABANDON steamid=nope`))).toBeNull();
  });
});

describe('handleAbandon', () => {
  it('aborts the match, frees the server, bans the leaver for a day, and tells admins', async () => {
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    expect(await handleAbandon(deps(), TOKEN, IDS[2])).toBe(matchId);
    off();
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string }).state).toBe('aborted');
    expect(released).toEqual([serverId]);
    expect(db.prepare('SELECT 1 FROM match_live WHERE match_id = ?').get(matchId)).toBeUndefined();
    expect(getPlayer(db, IDS[2])?.status).toBe('banned');
    const ban = activeBan(db, IDS[2])!;
    expect(ban.reason).toBe(`Abandoned match #${matchId}`);
    expect(Math.round((Date.parse(ban.expiresAt!) - Date.now()) / 60_000)).toBe(1440);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'abandon', steamid: IDS[2], matchId, minutes: 1440 }));
    for (const p of IDS.filter((x) => x !== IDS[2])) expect(getPlayer(db, p)?.status).toBe('active');
    // No rating change for anyone.
    expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history').get()).toEqual({ n: 0 });
  });

  it('is idempotent: the repeated heartbeat line does nothing the second time', async () => {
    await handleAbandon(deps(), TOKEN, IDS[2]);
    expect(await handleAbandon(deps(), TOKEN, IDS[2])).toBeNull();
    expect(released).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bans').get()).toEqual({ n: 1 });
  });

  it('does nothing when the server does not confirm, or the player is not on the roster', async () => {
    expect(await handleAbandon(deps(false), TOKEN, IDS[2])).toBeNull();
    expect(await handleAbandon(deps(), TOKEN, '76561199999999999')).toBeNull();
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string }).state).toBe('live');
    expect(released).toEqual([]);
  });

  it('escalates within 30 days: 1 day, 3 days, then 7 days', async () => {
    expect(abandonBanMinutes(db, IDS[2])).toBe(1440);
    await handleAbandon(deps(), TOKEN, IDS[2]);
    expect(abandonBanMinutes(db, IDS[2])).toBe(4320);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at, expires_at) VALUES (?, 'Abandoned match #99', 'system', ?, ?)")
      .run(IDS[2], new Date().toISOString(), new Date().toISOString());
    expect(abandonBanMinutes(db, IDS[2])).toBe(10080);
    db.prepare("UPDATE bans SET created_at = '2026-01-01T00:00:00.000Z'").run();
    expect(abandonBanMinutes(db, IDS[2])).toBe(1440);
  });
});

describe('statusShowsAbandoner', () => {
  const body = `STATUS state=live match=1\nSTATUS leave abandoner=${IDS[2]} budget=300 autounpause=1 paused=1\nSTATUS end`;
  it('matches only the recorded abandoner', () => {
    expect(statusShowsAbandoner(body, IDS[2])).toBe(true);
    expect(statusShowsAbandoner(body, IDS[3])).toBe(false);
    expect(statusShowsAbandoner(body.replace(IDS[2], 'none'), IDS[2])).toBe(false);
  });
});

describe('abandon teardown', () => {
  it('releases the box with a teardown', async () => {
    const calls: { id: number; opts: unknown }[] = [];
    const d = {
      db,
      releaser: { release: (id: number, opts: unknown) => void calls.push({ id, opts }) } as never,
      confirm: async () => true,
    };
    await handleAbandon(d, TOKEN, IDS[0]);
    expect(calls).toEqual([{ id: serverId, opts: { teardown: true } }]);
  });
});
