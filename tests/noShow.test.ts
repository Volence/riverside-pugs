import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, getServer, markLive } from '../src/serverPool.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { currentSeasonId } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { recordPlayerConnect, reapNoShowMatches } from '../src/noShow.js';
import { watchCauselessAborts } from './helpers.js';

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

/**
 * A match adopted from in game (!load_4v4p or auto-track), the shape every
 * match this server has ever actually run.
 *
 * Two things differ from the web-driven shape above and both matter:
 * went_live_at is never stamped, and NOBODY has a connected_at. The plugin
 * emits `PLAYER ... event=connect` only from OnClientPostAdminCheck, and an
 * adopted match rosters players who are already in game, so that forward never
 * fires for them.
 */
function adoptedMatch(db: DB): { id: number; serverId: number } {
  const serverId = addServer(db, {
    name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
  markLive(db, serverId);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, id);
  const id = Number(
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token)
       VALUES (?, 'live', 'no_mercy', ?, 'tok')`,
    ).run(currentSeasonId(db), serverId).lastInsertRowid,
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
    const causeless = watchCauselessAborts(db);

    const reaped = reapNoShowMatches(db, new ServerReleaser(db, async () => {}));

    expect(reaped).toEqual([id]);
    expect(causeless()).toEqual([]);
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
    const causeless = watchCauselessAborts(db);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([id]);
    expect(causeless()).toEqual([]);
    expect(db.prepare('SELECT abort_cause FROM matches WHERE id = ?').get(id)).toEqual({ abort_cause: 'no_round' });
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

  // Every other test in this file builds a WEB-driven match, which is why the
  // inverse of this very nearly shipped. An adopted match can never satisfy
  // rule 1: its roster is snapshotted from players already in game, so no
  // PLAYER connect line is ever emitted for them and connected_at stays NULL
  // for all eight forever. Enrolling those matches in the reaper (by stamping
  // went_live_at on adoption) therefore aborted a match people were actively
  // playing ten minutes after go-live, released the box under them, and
  // recorded nothing, because finishMatch bails on a match that is no longer
  // live. The guard that keeps them out is `went_live_at IS NOT NULL`.
  // These rows exist to be hand-edited in sqlite, so a blank value is not a
  // hypothetical: `UPDATE settings SET value = '' WHERE key = 'noshow_minutes'`
  // is one fat-fingered edit away. Number('') is 0, not NaN, so without the
  // emptiness check the fallback never engaged, noShowMin became 0, and
  // `age_min >= 0` matched every live match on the very next 60 second tick.
  it('falls back to the default when a threshold setting is blank, not to zero', () => {
    const db = openDb(':memory:');
    const { id, serverId } = liveMatch(db, 1);
    setSetting(db, 'noshow_minutes', '   ');

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as any).state).toBe('live');
    expect(getServer(db, serverId)!.status).toBe('live');
  });

  it('still honours a real numeric override', () => {
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 3);
    setSetting(db, 'noshow_minutes', '2');

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([id]);
  });

  it('never reaps an adopted in-game match, whose roster can never report a connect', () => {
    const db = openDb(':memory:');
    const { id, serverId } = adoptedMatch(db);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as any).state).toBe('live');
    expect(getServer(db, serverId)!.status).toBe('live');
  });
});

describe('no-show teardown', () => {
  it('releases the box with a teardown', () => {
    const db = openDb(':memory:');
    const { serverId } = liveMatch(db, 15);
    const seen: boolean[] = [];
    const releaser = new ServerReleaser(db, async (_s, _t, opts) => { seen.push(opts.teardown); });
    reapNoShowMatches(db, releaser);
    return new Promise<void>((r) => setImmediate(() => {
      expect(getServer(db, serverId)!.status).toBe('idle');
      expect(seen).toEqual([true]);
      r();
    }));
  });
});

describe('no-show deadline extension and file check rejects', () => {
  const releaser = (db: DB) => new ServerReleaser(db, async () => {});

  it('extra minutes on the match push the whole deadline back', () => {
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 12);
    db.prepare('UPDATE matches SET noshow_extra_minutes = 5 WHERE id = ?').run(id);
    expect(reapNoShowMatches(db, releaser(db))).toEqual([]);
    db.prepare("UPDATE matches SET went_live_at = datetime('now', '-16 minutes') WHERE id = ?").run(id);
    expect(reapNoShowMatches(db, releaser(db))).toEqual([id]);
  });

  it('the extension moves the no-round backstop too, so it cannot end a match the no-show rule is still waiting on', () => {
    const db = openDb(':memory:');
    setSetting(db, 'noshow_minutes', '10');
    setSetting(db, 'no_round_minutes', '30');
    const { id } = liveMatch(db, 31);
    for (const sid of IDS.slice(0, 3)) recordPlayerConnect(db, 'tok', sid);
    db.prepare('UPDATE matches SET noshow_extra_minutes = 25 WHERE id = ?').run(id);
    // 31 minutes live: past 30 but inside 10 + 25 and inside 30 + 25.
    expect(reapNoShowMatches(db, releaser(db))).toEqual([]);
    db.prepare("UPDATE matches SET went_live_at = datetime('now', '-56 minutes') WHERE id = ?").run(id);
    expect(reapNoShowMatches(db, releaser(db))).toEqual([id]);
  });

  it('a player the file check rejected tried to connect: no no-show for them, and the admin feed says so', async () => {
    const { penaltyHistory } = await import('../src/penalties.js');
    const { subscribeAdminEvents } = await import('../src/adminFeed.js');
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 20);
    db.prepare("UPDATE matches SET created_at = datetime('now', '-25 minutes') WHERE id = ?").run(id);
    // Five in, three out: two never tried, one was turned away by the file check.
    for (const p of IDS.slice(0, 5)) recordPlayerConnect(db, 'tok', p);
    db.prepare('INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at) VALUES (?, ?, 20, 3, ?)')
      .run(IDS[5], 'x', new Date(Date.now() - 10 * 60_000).toISOString());
    // A drop from before the pop is about some other match and spares nobody.
    db.prepare('INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at) VALUES (?, ?, 20, 3, ?)')
      .run(IDS[6], 'y', new Date(Date.now() - 60 * 60_000).toISOString());
    const texts: string[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') texts.push(e.text); });
    try {
      expect(reapNoShowMatches(db, releaser(db))).toEqual([id]);
    } finally {
      off();
    }
    expect(penaltyHistory(db, IDS[5])).toEqual([]);
    expect(penaltyHistory(db, IDS[6]).map((p) => p.kind)).toEqual(['no_show']);
    expect(penaltyHistory(db, IDS[7]).map((p) => p.kind)).toEqual(['no_show']);
    expect(texts[0]).toMatch(/One player was rejected by the file check/);
    const roles = db.prepare('SELECT player_id, role FROM match_abort_notices WHERE match_id = ? ORDER BY player_id').all(id);
    expect(roles).toContainEqual({ player_id: IDS[5], role: 'file_check' });
    expect(roles).toContainEqual({ player_id: IDS[7], role: 'culprit' });
    expect(roles).toContainEqual({ player_id: IDS[0], role: 'innocent' });
  });
});
