import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, getServer, markLive } from '../src/serverPool.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { currentSeasonId } from '../src/players.js';
import { recordPlayerConnect, reapNoShowMatches } from '../src/noShow.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

/** A live match whose went_live_at is `minutesAgo` in the past. */
function liveMatch(db: DB, minutesAgo: number): { id: number; serverId: number } {
  const serverId = addServer(db, {
    name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
  markLive(db, serverId);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, id);
  const id = Number(
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, went_live_at)
       VALUES (?, 'live', 'no_mercy', ?, 'tok', datetime('now', ?))`,
    ).run(currentSeasonId(db), serverId, `-${minutesAgo} minutes`).lastInsertRowid,
  );
  IDS.forEach((sid, i) => db.prepare(
    'INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)',
  ).run(id, sid, i < 4 ? 'a' : 'b'));
  return { id, serverId };
}

describe('no-show reaper', () => {
  it('aborts and frees the box when too few ever connected', () => {
    const db = openDb(':memory:');
    const { id, serverId } = liveMatch(db, 11);
    for (const sid of IDS.slice(0, 3)) recordPlayerConnect(db, 'tok', sid);

    const reaped = reapNoShowMatches(db, new ServerReleaser(db, async () => {}));

    expect(reaped).toEqual([id]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as any).state).toBe('aborted');
    expect(getServer(db, serverId)!.status).toBe('idle');
  });

  it('leaves a well attended match alone', () => {
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 11);
    for (const sid of IDS) recordPlayerConnect(db, 'tok', sid);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as any).state).toBe('live');
  });

  it('does not fire before the threshold', () => {
    const db = openDb(':memory:');
    liveMatch(db, 5);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
  });

  it('aborts on the backstop when everyone connected but no round was ever recorded', () => {
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 31);
    for (const sid of IDS) recordPlayerConnect(db, 'tok', sid);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([id]);
  });

  it('records the first connect only, so a reconnect does not move the timestamp', () => {
    const db = openDb(':memory:');
    liveMatch(db, 1);
    recordPlayerConnect(db, 'tok', IDS[0]);
    const first = (db.prepare(
      'SELECT connected_at FROM match_players WHERE player_id = ?',
    ).get(IDS[0]) as any).connected_at;

    recordPlayerConnect(db, 'tok', IDS[0]);

    expect((db.prepare(
      'SELECT connected_at FROM match_players WHERE player_id = ?',
    ).get(IDS[0]) as any).connected_at).toBe(first);
  });

  it('ignores a connect for an unknown token', () => {
    const db = openDb(':memory:');
    liveMatch(db, 1);
    expect(() => recordPlayerConnect(db, 'nope', IDS[0])).not.toThrow();
  });
});
