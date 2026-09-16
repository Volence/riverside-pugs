import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive, markOffline } from '../src/serverPool.js';
import { ServerReleaser, reconcileServers, type PasswordClearer } from '../src/serverRelease.js';

function seedServer(db: ReturnType<typeof openDb>): number {
  return addServer(db, {
    name: 'test', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
}

describe('ServerReleaser', () => {
  it('marks the server idle and clears the password', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const cleared: string[] = [];
    const clear: PasswordClearer = async (s) => { cleared.push(s.name); };

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
    const clear: PasswordClearer = () => new Promise((r) => { resolveClear = r; });
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

  it('is a no-op for a server id that does not exist', () => {
    const db = openDb(':memory:');
    const releaser = new ServerReleaser(db, async () => {});
    expect(() => releaser.release(999)).not.toThrow();
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

  it('leaves a server alone when a configuring match owns it', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    seedMatch(db, 'configuring', id);
    const releaser = new ServerReleaser(db, async () => {});

    expect(reconcileServers(db, releaser)).toEqual([]);
    expect(getServer(db, id)!.status).toBe('live');
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
