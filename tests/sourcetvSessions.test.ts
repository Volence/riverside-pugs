import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { hashIp, recordPlayerNet } from '../src/playerNetworks.js';
import { recordSourceTv, sessionsForMatch, likelyAccounts, onSourceTv } from '../src/sourcetvSessions.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';

const MAIN = '76561198005192652';
const OTHER = '76561197972484944';

function makeServer(db: DB, name = 'Dallas'): number {
  return Number(
    db.prepare(
      "INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES (?, 'h', 1, 1, 'p')",
    ).run(name).lastInsertRowid,
  );
}

function makeMatch(db: DB, serverId: number | null, state = 'live'): number {
  return Number(
    db.prepare('INSERT INTO matches (season_id, state, campaign, server_id) VALUES (1, ?, ?, ?)')
      .run(state, 'dead_air', serverId).lastInsertRowid,
  );
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('sourcetv sessions', () => {
  it('opens a row on join, hashed, with the live match on that server', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    const { opened } = recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    expect(opened).toBeTypeOf('number');

    const rows = db.prepare('SELECT * FROM sourcetv_sessions').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      server_id: serverId, match_id: matchId, slot: 1, name: 'Watcher', country: 'US', left_at: null,
    });
    expect(rows[0].ip_hash).toBe(hashIp(db, '203.0.113.9'));

    // The raw address must never appear in any column of any stored row.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('203.0.113.9');
  });

  it('picks the live match on that server, not one live on a different server', () => {
    const serverId = makeServer(db, 'Dallas');
    const otherServerId = makeServer(db, 'Chicago');
    makeMatch(db, otherServerId, 'live');
    // No live match on serverId itself.
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    const row = db.prepare('SELECT match_id FROM sourcetv_sessions').get() as { match_id: number | null };
    expect(row.match_id).toBeNull();
  });

  it('closes the open row on leave, storing the reason', () => {
    const serverId = makeServer(db);
    makeMatch(db, serverId);
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 2, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 2, reason: 'Disconnect', name: 'Watcher',
    });
    const row = db.prepare('SELECT left_at, leave_reason FROM sourcetv_sessions').get() as
      { left_at: string | null; leave_reason: string | null };
    expect(row.left_at).not.toBeNull();
    expect(row.leave_reason).toBe('Disconnect');
  });

  it('ignores a leave with no open row for that server and slot', () => {
    const serverId = makeServer(db);
    expect(() => recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 9, reason: 'Disconnect', name: 'Nobody',
    })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sourcetv_sessions').get()).toEqual({ n: 0 });
  });

  it('closes a stale open row as replaced when a second join lands on the same slot', () => {
    const serverId = makeServer(db);
    makeMatch(db, serverId);
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 3, ip: '203.0.113.9', country: 'US', name: 'First',
    });
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 3, ip: '198.51.100.4', country: 'BR', name: 'Second',
    });
    const rows = db.prepare('SELECT name, left_at, leave_reason FROM sourcetv_sessions ORDER BY id').all() as
      { name: string; left_at: string | null; leave_reason: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'First', leave_reason: 'replaced' });
    expect(rows[0].left_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ name: 'Second', left_at: null, leave_reason: null });
  });

  it('closes only open rows on that server when SourceTV stops, and records the event', () => {
    const serverId = makeServer(db, 'Dallas');
    const otherServerId = makeServer(db, 'Chicago');
    makeMatch(db, serverId);
    makeMatch(db, otherServerId);
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'A',
    });
    recordSourceTv(db, otherServerId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '198.51.100.4', country: 'BR', name: 'B',
    });
    recordSourceTv(db, serverId, { kind: 'sourcetv', event: 'stop' });

    const closed = db.prepare('SELECT left_at, leave_reason FROM sourcetv_sessions WHERE server_id = ?')
      .get(serverId) as { left_at: string | null; leave_reason: string | null };
    expect(closed.left_at).not.toBeNull();
    expect(closed.leave_reason).toBe('SourceTV stopped');

    const stillOpen = db.prepare('SELECT left_at FROM sourcetv_sessions WHERE server_id = ?')
      .get(otherServerId) as { left_at: string | null };
    expect(stillOpen.left_at).toBeNull();

    const events = db.prepare('SELECT event FROM sourcetv_server_events WHERE server_id = ?').all(serverId);
    expect(events).toEqual([{ event: 'stop' }]);
  });

  it('records a start event', () => {
    const serverId = makeServer(db);
    recordSourceTv(db, serverId, { kind: 'sourcetv', event: 'start' });
    const events = db.prepare('SELECT event FROM sourcetv_server_events WHERE server_id = ?').all(serverId);
    expect(events).toEqual([{ event: 'start' }]);
  });

  it('lists sessions for a match with joined/left/reason and matched accounts', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });

    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 1, reason: 'Disconnect', name: 'Watcher',
    });

    const sessions = sessionsForMatch(db, matchId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      name: 'Watcher', country: 'US', leaveReason: 'Disconnect',
      accounts: [{ steamid: MAIN, name: 'Main' }],
    });
    expect(sessions[0].joinedAt).toBeTypeOf('string');
    expect(sessions[0].leftAt).toBeTypeOf('string');
  });

  it('likelyAccounts returns only the players whose recorded network matches the hash', () => {
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    upsertPlayer(db, { steamid: OTHER, name: 'Other', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: OTHER, ip: '198.51.100.4', country: 'BR' });

    const matches = likelyAccounts(db, hashIp(db, '203.0.113.9'));
    expect(matches).toEqual([{ steamid: MAIN, name: 'Main' }]);
  });

  it('never stores the raw address in any column of any table it writes', () => {
    const serverId = makeServer(db);
    makeMatch(db, serverId);
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 1, reason: 'Disconnect', name: 'Watcher',
    });
    const dump = JSON.stringify([
      ...db.prepare('SELECT * FROM sourcetv_sessions').all(),
      ...db.prepare('SELECT * FROM sourcetv_server_events').all(),
    ]);
    expect(dump).not.toContain('203.0.113.9');
  });
});

describe('onSourceTv admin alert', () => {
  let events: AdminEvent[];
  let unsub: () => void;

  beforeEach(() => {
    events = [];
    unsub = subscribeAdminEvents((e) => events.push(e));
  });
  afterEach(() => unsub());

  function roster(matchId: number, steamid: string, team: 'a' | 'b' = 'a'): void {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(matchId, steamid, team);
  }

  it('publishes an admin alert when a likely account is rostered in the live match', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    roster(matchId, MAIN);

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toEqual([
      { kind: 'sourcetv_watch', matchId, serverId, spectatorName: 'Watcher', steamids: [MAIN] },
    ]);
  });

  it('alerts nobody when the server has no live match', () => {
    const serverId = makeServer(db);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toEqual([]);
  });

  it('alerts nobody for a likely account that is not rostered in the live match', () => {
    const serverId = makeServer(db);
    makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    // MAIN is never rostered into the live match.

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toEqual([]);
  });

  it('names only the rostered accounts sharing the connection, leaving out a sharer who is not rostered', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    upsertPlayer(db, { steamid: OTHER, name: 'Other', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: OTHER, ip: '203.0.113.9', country: 'US' });
    roster(matchId, MAIN);

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toEqual([
      { kind: 'sourcetv_watch', matchId, serverId, spectatorName: 'Watcher', steamids: [MAIN] },
    ]);
  });

  it('two rostered players sharing the connection produce one post naming both', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    upsertPlayer(db, { steamid: OTHER, name: 'Other', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: OTHER, ip: '203.0.113.9', country: 'US' });
    roster(matchId, MAIN);
    roster(matchId, OTHER, 'b');

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'sourcetv_watch', matchId, serverId, spectatorName: 'Watcher' });
    const posted = events[0] as Extract<AdminEvent, { kind: 'sourcetv_watch' }>;
    expect(posted.steamids.sort()).toEqual([MAIN, OTHER].sort());
  });

  it('reconnect in the same match from the same connection posts once in total', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    roster(matchId, MAIN);

    // Join, leave, and reconnect: the ordinary map-change cycle.
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 1, reason: 'Disconnect', name: 'Watcher',
    });
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 1, reason: 'Disconnect', name: 'Watcher',
    });
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 2, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toHaveLength(1);
  });

  it('a spectator who joins before the matching player connects still gets exactly one post on reconnect', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    roster(matchId, MAIN);

    // The spectator joins before the rostered player's own connection has
    // been recorded, so likelyAccounts finds nobody yet: no post, but the
    // session row for this match+connection now exists.
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    expect(events).toHaveLength(0);
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 1, reason: 'Disconnect', name: 'Watcher',
    });

    // The rostered player now connects to the game server on that same
    // connection.
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });

    // The spectator reconnects, the ordinary map-change cycle. This is the
    // first time the match+connection actually has anything to report, so
    // it must post, not be suppressed by the earlier no-op session.
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 2, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toHaveLength(1);
    expect((events[0] as Extract<AdminEvent, { kind: 'sourcetv_watch' }>).steamids).toEqual([MAIN]);
  });

  it('a different connection in the same match still posts', () => {
    const serverId = makeServer(db);
    const matchId = makeMatch(db, serverId);
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    upsertPlayer(db, { steamid: OTHER, name: 'Other', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: OTHER, ip: '198.51.100.4', country: 'BR' });
    roster(matchId, MAIN);
    roster(matchId, OTHER, 'b');

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'WatcherA',
    });
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 2, ip: '198.51.100.4', country: 'BR', name: 'WatcherB',
    });

    expect(events).toHaveLength(2);
  });

  it('the same connection in a different match posts again', () => {
    const serverId = makeServer(db);
    const firstMatch = makeMatch(db, serverId, 'live');
    upsertPlayer(db, { steamid: MAIN, name: 'Main', avatar: null }, []);
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    roster(firstMatch, MAIN);

    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'leave', slot: 1, reason: 'Disconnect', name: 'Watcher',
    });
    db.prepare('UPDATE matches SET state = ? WHERE id = ?').run('completed', firstMatch);

    const secondMatch = makeMatch(db, serverId, 'live');
    roster(secondMatch, MAIN);
    onSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'Watcher',
    });

    expect(events).toHaveLength(2);
    expect((events[0] as Extract<AdminEvent, { kind: 'sourcetv_watch' }>).matchId).toBe(firstMatch);
    expect((events[1] as Extract<AdminEvent, { kind: 'sourcetv_watch' }>).matchId).toBe(secondMatch);
  });
});

describe('SourceTV restart reaper', () => {
  it('closes every open row on that server with SourceTV restarted, leaving other servers alone', () => {
    const serverId = makeServer(db, 'Dallas');
    const otherServerId = makeServer(db, 'Chicago');
    makeMatch(db, serverId);
    makeMatch(db, otherServerId);
    recordSourceTv(db, serverId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '203.0.113.9', country: 'US', name: 'A',
    });
    recordSourceTv(db, otherServerId, {
      kind: 'sourcetv', event: 'join', slot: 1, ip: '198.51.100.4', country: 'BR', name: 'B',
    });

    // A crashed server never sends stop; the relay reports start when it
    // comes back up, with no leave ever recorded for the old row.
    recordSourceTv(db, serverId, { kind: 'sourcetv', event: 'start' });

    const closed = db.prepare('SELECT left_at, leave_reason FROM sourcetv_sessions WHERE server_id = ?')
      .get(serverId) as { left_at: string | null; leave_reason: string | null };
    expect(closed.left_at).not.toBeNull();
    expect(closed.leave_reason).toBe('SourceTV restarted');

    const stillOpen = db.prepare('SELECT left_at FROM sourcetv_sessions WHERE server_id = ?')
      .get(otherServerId) as { left_at: string | null };
    expect(stillOpen.left_at).toBeNull();

    const events = db.prepare('SELECT event FROM sourcetv_server_events WHERE server_id = ?').all(serverId);
    expect(events).toEqual([{ event: 'start' }]);
  });
});
