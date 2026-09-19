import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive, markOffline } from '../src/serverPool.js';
import { ServerReleaser, reconcileServers, type ServerCleaner } from '../src/serverRelease.js';

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
