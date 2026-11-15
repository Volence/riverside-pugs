import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { feedChannel } from '../src/discord/feedRouting.js';
import { sweepSlowReadyups, rosterInSince } from '../src/slowReadyup.js';
import { recordPresenceLine } from '../src/presence.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000010${i}`);
const TOKEN = 'b'.repeat(32);
const T0 = Date.UTC(2026, 10, 15, 20, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000);
/** The way SQLite's datetime('now') writes it, which is how started_at, last_seen and connected_at arrive. */
const sql = (s: number) => at(s).toISOString().replace('T', ' ').slice(0, 19);

let db: DB;
let matchId: number;

function readyup(o: { ordinal?: number; half?: number | null; startedS?: number; unready?: string[]; phase?: string } = {}): number {
  const unready = JSON.stringify(o.unready ?? [IDS[3]]);
  db.prepare(
    `INSERT INTO match_live (match_id, current_map, last_seen, phase, phase_since, phase_unready, phase_unready_at)
     VALUES (?, 'l4d_vs_airport01_greenhouse', ?, ?, ?, ?, ?)
     ON CONFLICT (match_id) DO UPDATE SET phase = excluded.phase, phase_unready = excluded.phase_unready, last_seen = excluded.last_seen`,
  ).run(matchId, sql(o.startedS ?? 0), o.phase ?? 'readyup', sql(o.startedS ?? 0), unready, sql(o.startedS ?? 0));
  return Number(db.prepare(
    'INSERT INTO match_readyups (match_id, map_ordinal, half, started_at, last_unready) VALUES (?, ?, ?, ?, ?)',
  ).run(matchId, o.ordinal ?? 1, o.half === undefined ? null : o.half, sql(o.startedS ?? 0), unready).lastInsertRowid);
}
/** The heartbeat keeps last_seen fresh. */
const heartbeat = (s: number) => db.prepare('UPDATE match_live SET last_seen = ? WHERE match_id = ?').run(sql(s), matchId);
const connectAll = (s: number) => db.prepare('UPDATE match_players SET connected_at = ? WHERE match_id = ?').run(sql(s), matchId);

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
  });
  db.prepare("INSERT INTO servers (id, name, host, port, rcon_port, rcon_password) VALUES (3, 'Riverside #3', '1.2.3.4', 27015, 27015, 'x')").run();
  matchId = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token, origin) VALUES (1, 'live', 'dead_air', 3, ?, 'queue')",
  ).run(TOKEN).lastInsertRowid);
  const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'web')");
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
});

describe('sweepSlowReadyups', () => {
  it('pings once past five minutes with everyone on the server, naming who is not ready', () => {
    connectAll(-600);
    readyup({ ordinal: 1, half: null, startedS: 0, unready: [IDS[3], IDS[6]] });
    heartbeat(299);
    expect(sweepSlowReadyups(db, at(299))).toEqual([]);
    heartbeat(300);
    expect(sweepSlowReadyups(db, at(300))).toEqual([{
      matchId, serverId: 3, serverName: 'Riverside #3', map: 'l4d_vs_airport01_greenhouse',
      mapOrdinal: 1, half: 1, waitedS: 300, unready: [IDS[3], IDS[6]],
    }]);
    heartbeat(400);
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
  });

  it('reads the half the ready-up is in front of: after half 1 it is half 2, after half 2 it is the end', () => {
    connectAll(-600);
    readyup({ half: 1, startedS: 0 });
    heartbeat(301);
    expect(sweepSlowReadyups(db, at(301))[0]).toMatchObject({ half: 2 });

    db.prepare('UPDATE match_readyups SET ended_at = ? WHERE match_id = ?').run(sql(302), matchId);
    readyup({ half: 2, startedS: 400 });
    heartbeat(1000);
    expect(sweepSlowReadyups(db, at(1000))).toEqual([]);
  });

  it('starts the clock when the last player connected, which is what lets the match-start ready-up count', () => {
    connectAll(0);
    db.prepare('UPDATE match_players SET connected_at = NULL WHERE player_id = ?').run(IDS[5]);
    readyup({ ordinal: 0, half: null, startedS: 0 });
    heartbeat(400);
    // Someone has never connected: the no-show reaper's business, not this.
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
    db.prepare('UPDATE match_players SET connected_at = ? WHERE player_id = ?').run(sql(240), IDS[5]);
    heartbeat(539);
    expect(sweepSlowReadyups(db, at(539))).toEqual([]);
    heartbeat(540);
    expect(sweepSlowReadyups(db, at(540))).toEqual([expect.objectContaining({ mapOrdinal: 0, half: 1, waitedS: 300 })]);
  });

  it('stops while someone is disconnected, and restarts from their return', () => {
    connectAll(-600);
    readyup({ startedS: 0 });
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(100));
    heartbeat(400);
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
    recordPresenceLine(db, { kind: 'return', token: TOKEN, steamid: IDS[2], remaining: 200 }, at(420));
    heartbeat(719);
    expect(sweepSlowReadyups(db, at(719))).toEqual([]);
    heartbeat(720);
    expect(sweepSlowReadyups(db, at(720))).toEqual([expect.objectContaining({ waitedS: 300 })]);
  });

  it('never pings during a pause, and a pause inside a ready-up cannot make a second ping for it', () => {
    connectAll(-600);
    readyup({ startedS: 0, phase: 'paused' });
    heartbeat(600);
    expect(sweepSlowReadyups(db, at(600))).toEqual([]);

    db.prepare('UPDATE match_readyups SET ended_at = ? WHERE match_id = ?').run(sql(600), matchId);
    readyup({ startedS: 610 });
    heartbeat(910);
    expect(sweepSlowReadyups(db, at(910))).toHaveLength(1);
    // Paused again, then a third row for the same map and half.
    db.prepare('UPDATE match_readyups SET ended_at = ? WHERE match_id = ?').run(sql(920), matchId);
    readyup({ startedS: 930 });
    heartbeat(2000);
    expect(sweepSlowReadyups(db, at(2000))).toEqual([]);
  });

  it('says nothing for a stale box, the go-live countdown, a non-queue match, or with the setting at 0', () => {
    connectAll(-600);
    readyup({ startedS: 0 });
    expect(sweepSlowReadyups(db, at(400))).toEqual([]); // last heartbeat 400 s ago

    heartbeat(400);
    db.prepare("UPDATE match_live SET phase_unready = '[]' WHERE match_id = ?").run(matchId);
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
    db.prepare('UPDATE match_live SET phase_unready = ? WHERE match_id = ?').run(JSON.stringify([IDS[1]]), matchId);

    db.prepare("UPDATE matches SET origin = 'in_game' WHERE id = ?").run(matchId);
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
    db.prepare("UPDATE matches SET origin = 'queue', kind = 'scrim' WHERE id = ?").run(matchId);
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
    db.prepare("UPDATE matches SET kind = 'pug' WHERE id = ?").run(matchId);

    setSetting(db, 'slow_readyup_ping_minutes', '0');
    expect(sweepSlowReadyups(db, at(400))).toEqual([]);
    setSetting(db, 'slow_readyup_ping_minutes', '2');
    expect(sweepSlowReadyups(db, at(400))).toHaveLength(1);
  });

  it('rosterInSince prefers the presence row and refuses anyone dropped', () => {
    connectAll(0);
    expect(rosterInSince(db, matchId)).toBe(T0);
    recordPresenceLine(db, { kind: 'player', token: TOKEN, steamid: IDS[0], event: 'connect' }, at(50));
    expect(rosterInSince(db, matchId)).toBe(T0 + 50_000);
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[0], remaining: 300 }, at(60));
    expect(rosterInSince(db, matchId)).toBeNull();
  });
});

describe('the slow ready-up post', () => {
  let t: FakeTransport;
  let feed: AdminFeedPoster;
  beforeEach(() => {
    IDS.forEach((id, i) => linkDiscord(db, id, `91${i}`, `d${i}`));
    setSetting(db, 'discord_admin_channel_id', 'admins');
    setSetting(db, 'discord_mod_channel_id', 'mods');
    setSetting(db, 'mod_call_role_id', '123456789012345678');
    t = new FakeTransport();
    feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
    feed.start();
  });
  afterEach(() => feed.stop());

  const event = {
    kind: 'slow_readyup' as const, matchId: 41, serverName: 'Riverside #3', map: 'l4d_vs_airport01_greenhouse',
    mapOrdinal: 1, half: 2 as const, waitedS: 312, unready: [IDS[3], IDS[6]],
  };

  it('goes to the mod channel, pings the mod call role, and names the match, server, map, half and players', async () => {
    publishAdminEvent(event);
    await feed.idle();
    const [m] = t.live();
    expect(m.channelId).toBe('mods');
    expect(m.payload.content).toBe('<@&123456789012345678>');
    expect(m.payload.mentionRoleIds).toEqual(['123456789012345678']);
    const line = m.payload.embeds?.[0]?.description ?? '';
    expect(line).toContain('Slow ready-up in match [#41](https://pug.test/match/41) on Riverside #3, `l4d_vs_airport01_greenhouse`, map 2 half 2: 5:12 with everyone on the server.');
    expect(line).toContain('player3');
    expect(line).toContain('player6');
    expect(line).toContain('[Live board](https://pug.test/admin/live?live=41)');
    expect(line).not.toContain('\u2014');
  });

  it('the minutes setting at 0 is also the feed switch', () => {
    expect(feedChannel(db, event)).toBe('mods');
    setSetting(db, 'slow_readyup_ping_minutes', '0');
    expect(feedChannel(db, event)).toBeNull();
  });
});
