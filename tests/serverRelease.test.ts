import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive, markOffline } from '../src/serverPool.js';
import { ServerReleaser, reconcileServers, recoverOfflineServers, type ServerCleaner } from '../src/serverRelease.js';
import type { ServerRestarter } from '../src/serverRestart.js';

function seedServer(db: ReturnType<typeof openDb>): number {
  return addServer(db, {
    name: 'test', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
}

function seedMatchOn(
  db: ReturnType<typeof openDb>, serverId: number, state: string, token: string | null,
): number {
  // openDb seeds 'Season 1' as id 1 already.
  return Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, ?, 'no_mercy', ?, ?)",
  ).run(state, serverId, token).lastInsertRowid);
}

describe('ServerReleaser', () => {
  it('marks the server idle and clears the password', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const cleared: string[] = [];
    const clear: ServerCleaner = async (s) => { cleared.push(s.name); };

    const releaser = new ServerReleaser(db, clear);
    releaser.release(id);

    expect(getServer(db, id)!.status).toBe('idle');
    await new Promise((r) => setImmediate(r));
    expect(cleared).toEqual(['test']);
  });

  it('notifies every registered waiter only after the password clear settles', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const calls: number[] = [];
    let resolveClear: () => void = () => {};
    const clear: ServerCleaner = () => new Promise((r) => { resolveClear = r; });
    const releaser = new ServerReleaser(db, clear);
    releaser.onFreed(() => calls.push(1));
    releaser.onFreed(() => calls.push(2));

    releaser.release(id);
    // The DB flip is synchronous, but the clear has not settled yet, so no
    // waiter should have fired: a later claimant must not race the old
    // sv_password clear landing after its own fresh one.
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([]);

    resolveClear();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([1, 2]);
  });

  it('still notifies waiters when the password clear rejects', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const calls: number[] = [];
    const releaser = new ServerReleaser(db, async () => { throw new Error('rcon down'); });
    releaser.onFreed(() => calls.push(1));

    releaser.release(id);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // A dead rcon target must never wedge the queue: a rejected clear still
    // has to wake whoever is waiting for a server.
    expect(calls).toEqual([1]);
  });

  it('still frees the row when clearing the password throws', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const releaser = new ServerReleaser(db, async () => { throw new Error('rcon down'); });

    releaser.release(id);

    expect(getServer(db, id)!.status).toBe('idle');
    await new Promise((r) => setImmediate(r));
  });

  // Freeing the row and clearing the password left the PLUGIN still holding a
  // live match with the old roster and token. After a no-show abort that meant
  // the box was advertised as claimable while the plugin was still enforcing a
  // match on it, so the next queue pop configured a second match over the top
  // of a first one the plugin had never been told about.
  it('hands the cleaner the token of the match that owned the box', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    seedMatchOn(db, id, 'aborted', 'tok_dead_beef');
    const seen: Array<string | null> = [];
    const releaser = new ServerReleaser(db, async (_s, token) => { seen.push(token); });

    releaser.release(id);
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(['tok_dead_beef']);
  });

  it('takes the most recent match on the box when the box has a history', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    seedMatchOn(db, id, 'completed', 'tok_old');
    seedMatchOn(db, id, 'aborted', 'tok_new');
    const seen: Array<string | null> = [];
    const releaser = new ServerReleaser(db, async (_s, token) => { seen.push(token); });

    releaser.release(id);
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(['tok_new']);
  });

  it('passes a null token when no match on the box ever got one', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    seedMatchOn(db, id, 'aborted', null);
    const seen: Array<string | null> = [];
    const releaser = new ServerReleaser(db, async (_s, token) => { seen.push(token); });

    releaser.release(id);
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([null]);
  });

  it('is a no-op for a server id that does not exist', () => {
    const db = openDb(':memory:');
    const releaser = new ServerReleaser(db, async () => {});
    expect(() => releaser.release(999)).not.toThrow();
  });

  it('tells the cleaner this is not a teardown unless asked', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const seen: boolean[] = [];
    const clear: ServerCleaner = async (_s, _t, opts) => { seen.push(opts.teardown); };
    const releaser = new ServerReleaser(db, clear);
    releaser.release(id);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([false]);
  });

  it('passes a requested teardown through to the cleaner', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const seen: boolean[] = [];
    const clear: ServerCleaner = async (_s, _t, opts) => { seen.push(opts.teardown); };
    const releaser = new ServerReleaser(db, clear);
    releaser.release(id, { teardown: true });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([true]);
  });

  it('runs the before-restart hook after the cleanup and before the restart', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    db.prepare('UPDATE servers SET restart_after_match = 1 WHERE id = ?').run(id);
    const order: string[] = [];
    const restarter: ServerRestarter = { restart: async () => { order.push('restart'); return true; } };
    const releaser = new ServerReleaser(db, async () => { order.push('clean'); }, restarter,
      async (s) => { order.push(`hook:${s.id}`); });
    releaser.release(id, { restart: true });
    await releaser.settled();
    expect(order).toEqual(['clean', `hook:${id}`, 'restart']);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('a hook that throws still restarts and frees the box', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const releaser = new ServerReleaser(db, async () => {}, null, async () => { throw new Error('ftp down'); });
    releaser.release(id);
    await releaser.settled();
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('refuses to release a box a booking holds unless the booking asks', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    const cleaned: string[] = [];
    const releaser = new ServerReleaser(db, async (s) => { cleaned.push(s.name); });
    // A box held by an open booking.
    db.prepare("INSERT INTO players (steamid, name, status) VALUES ('76561199000000001', 'a', 'active')").run();
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'active', ?, 'p', 't', 'standard', '{}', '[]', '76561199000000001', 'x')`,
    ).run(id);

    const settled: boolean[] = [];
    releaser.release(id, { restart: true }, (back) => settled.push(back));
    await releaser.settled();
    expect(cleaned).toEqual([]);
    expect(getServer(db, id)!.status).toBe('idle');
    expect(settled).toEqual([false]);

    releaser.release(id, { restart: true, forceRestart: true, booking: true }, (back) => settled.push(back));
    await releaser.settled();
    expect(cleaned).toHaveLength(1);
  });
});

describe('ServerReleaser and a gone box', () => {
  it('refuses a box whose gone_since is set, booking or not, unless it is the gone give-back', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markOffline(db, id);
    db.prepare("UPDATE servers SET gone_since = '2026-10-02T20:00:00.000Z' WHERE id = ?").run(id);
    const cleaned: string[] = [];
    const releaser = new ServerReleaser(db, async (s) => { cleaned.push(s.name); });
    const settled: boolean[] = [];
    releaser.release(id, {}, (back) => settled.push(back));
    releaser.release(id, { restart: true, forceRestart: true, booking: true }, (back) => settled.push(back));
    await releaser.settled();
    expect(cleaned).toEqual([]);
    expect(getServer(db, id)!.status).toBe('offline');
    expect(settled).toEqual([false, false]);

    releaser.release(id, { gone: true }, (back) => settled.push(back));
    await releaser.settled();
    expect(cleaned).toEqual(['test']);
    expect(getServer(db, id)!.status).toBe('idle');
    expect(settled).toEqual([false, false, true]);
  });
});

describe('reconcileServers', () => {
  function seedMatch(db: ReturnType<typeof openDb>, state: string, serverId: number | null): void {
    // openDb seeds 'Season 1' as id 1 already.
    db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id) VALUES (1, ?, 'no_mercy', ?)",
    ).run(state, serverId);
  }

  it('frees a server stranded with no owning match', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([id]);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('leaves alone a server it is told to keep', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(id);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser, [id])).toEqual([]);
    expect(getServer(db, id)!.status).toBe('reserved');
  });

  it('leaves a server alone when a live match owns it', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    seedMatch(db, 'live', id);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([]);
    expect(getServer(db, id)!.status).toBe('live');
  });

  // The inverse of this used to be asserted here, and it deadlocked the queue.
  // A 'configuring' match only ever holds a server_id because setupMatch got
  // as far as writing it (orchestrator.ts) and the process then died before
  // flipping the match to 'live'. Skipping that server at boot left the match
  // pending forever: rebuildFromDb re-pends it, drain calls setupMatch,
  // claimIdle finds nothing because the only box is the one this very match is
  // holding, onNoServer re-pends it, round and round. Since hasOpenMatch
  // counts 'configuring', all eight players were locked out of the queue too.
  it('frees a server held by a configuring match, which can only be a crashed setup', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    seedMatch(db, 'configuring', id);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([id]);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  // The other half of that reasoning: a match that is merely WAITING for a box
  // has no server_id at all, because setupMatch writes one only after a
  // successful claimIdle. So narrowing the exclusion to 'live' cannot reconcile
  // a server out from under a match that is legitimately mid-setup.
  it('has nothing to reconcile when a waiting configuring match holds no server', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    seedMatch(db, 'configuring', null);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([]);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('does not touch an already-idle server', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([]);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('leaves an offline server with no owning match offline, not idle', () => {
    // offline is the DEFAULT status for every newly inserted row (src/db.ts),
    // and nothing in production ever calls markOffline: it means "not
    // verified reachable yet", not "a crash stranded this mid-match". Auto-
    // promoting it to idle would make an unverified server claimable.
    const db = openDb(':memory:');
    const id = seedServer(db);
    markOffline(db, id);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([]);
    expect(getServer(db, id)!.status).toBe('offline');
  });
});

describe('recoverOfflineServers (a web restart lost the after-match flip)', () => {
  /** A box a release took offline for its after-match restart: restart set,
   *  enabled, offline, its last match over. */
  function stranded(db: ReturnType<typeof openDb>): number {
    const id = seedServer(db);
    db.prepare('UPDATE servers SET restart_after_match = 1, enabled = 1 WHERE id = ?').run(id);
    const m = seedMatchOn(db, id, 'completed', 'tok-done');
    db.prepare("UPDATE matches SET ended_at = datetime('now', '-1 minute') WHERE id = ?").run(m);
    markOffline(db, id);
    return id;
  }
  const free = async () => ({ idle: true, humans: 0 });

  it('sets a stranded box idle once it answers free, and wakes the waiters', async () => {
    const db = openDb(':memory:');
    const id = stranded(db);
    const releaser = new ServerReleaser(db, async () => {});
    let woke = 0;
    releaser.onFreed(() => { woke++; });
    const asked: string[] = [];
    expect(await recoverOfflineServers(db, releaser, async (s) => { asked.push(s.name); return free(); })).toEqual([id]);
    expect(asked).toEqual(['test']);
    expect(getServer(db, id)!.status).toBe('idle');
    expect(woke).toBe(1);
  });

  it('leaves it offline when it does not answer, has humans, or holds a match', async () => {
    for (const answer of [null, { idle: true, humans: 2 }, { idle: false, humans: 0 }]) {
      const db = openDb(':memory:');
      const id = stranded(db);
      expect(await recoverOfflineServers(db, new ServerReleaser(db, async () => {}), async () => answer)).toEqual([]);
      expect(getServer(db, id)!.status).toBe('offline');
    }
    const db = openDb(':memory:');
    const id = stranded(db);
    expect(await recoverOfflineServers(db, new ServerReleaser(db, async () => {}), async () => { throw new Error('rcon connect timeout'); })).toEqual([]);
    expect(getServer(db, id)!.status).toBe('offline');
  });

  it('never asks a box that is not this strand', async () => {
    const cases: Array<(db: ReturnType<typeof openDb>, id: number) => void> = [
      (db, id) => db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(id),
      (db, id) => db.prepare('UPDATE servers SET retired = 1 WHERE id = ?').run(id),
      (db, id) => db.prepare('UPDATE servers SET restart_after_match = 0 WHERE id = ?').run(id),
      (db, id) => db.prepare("UPDATE servers SET gone_since = datetime('now') WHERE id = ?").run(id),
      (db, id) => { seedMatchOn(db, id, 'live', 'tok-live'); },
      (db, id) => { seedMatchOn(db, id, 'configuring', 'tok-conf'); },
      (db, id) => db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (?, 't', 'p')").run(id),
      (db, id) => {
        db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000009', 'o')").run();
        db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
          VALUES (?, 'park', '76561199000000009', 'pw', datetime('now', '+1 hour'))`).run(id);
      },
      // Parked by the release engine after the match: offline on purpose.
      (db, id) => {
        const r = Number(db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'deploying', '1', datetime('now'))").run().lastInsertRowid);
        db.prepare("INSERT INTO release_boxes (release_id, server_id, state, error, plan_json, shipped_json, updated_at) VALUES (?, ?, 'written', 'written, restart pending: x', NULL, '{}', datetime('now'))").run(r, id);
      },
    ];
    for (const setup of cases) {
      const db = openDb(':memory:');
      const id = stranded(db);
      setup(db, id);
      const asked: number[] = [];
      expect(await recoverOfflineServers(db, new ServerReleaser(db, async () => {}), async (s) => { asked.push(s.id); return free(); })).toEqual([]);
      expect(asked).toEqual([]);
      expect(getServer(db, id)!.status).toBe('offline');
    }
    // A never-used row: 'offline' is the schema default for an unverified box.
    const db = openDb(':memory:');
    const id = seedServer(db);
    db.prepare("UPDATE servers SET restart_after_match = 1, status = 'offline' WHERE id = ?").run(id);
    expect(await recoverOfflineServers(db, new ServerReleaser(db, async () => {}), free)).toEqual([]);
  });

  it('an older release park does not block a later strand', async () => {
    const db = openDb(':memory:');
    const id = stranded(db);
    const r = Number(db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'deploying', '1', datetime('now'))").run().lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, error, plan_json, shipped_json, updated_at) VALUES (?, ?, 'written', 'old', NULL, '{}', datetime('now', '-1 day'))").run(r, id);
    expect(await recoverOfflineServers(db, new ServerReleaser(db, async () => {}), free)).toEqual([id]);
  });

  it('skips a box this process is restarting, and one a match took while it was being asked', async () => {
    const db = openDb(':memory:');
    const id = stranded(db);
    let finish!: (v: boolean) => void;
    const restarter: ServerRestarter = { restart: () => new Promise<boolean>((r) => { finish = r; }) };
    const releaser = new ServerReleaser(db, async () => {}, restarter);
    markLive(db, id);
    releaser.release(id, { restart: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(releaser.isRestarting(id)).toBe(true);
    const asked: number[] = [];
    expect(await recoverOfflineServers(db, releaser, async (s) => { asked.push(s.id); return free(); })).toEqual([]);
    expect(asked).toEqual([]);
    finish(true);

    const db2 = openDb(':memory:');
    const id2 = stranded(db2);
    expect(await recoverOfflineServers(db2, new ServerReleaser(db2, async () => {}), async () => {
      seedMatchOn(db2, id2, 'configuring', 'tok-new');
      return free();
    })).toEqual([]);
    expect(getServer(db2, id2)!.status).toBe('offline');
  });
});
