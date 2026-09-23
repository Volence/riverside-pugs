import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { hashIp, recordPlayerNet } from '../src/playerNetworks.js';
import { recordSourceTv, sessionsForMatch, likelyAccounts } from '../src/sourcetvSessions.js';

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
