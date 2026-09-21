import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, getServer, markLive, setRestartAfterMatch, type ServerRow } from '../src/serverPool.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { rconRestarter, restartsAfterMatch, type ServerRestarter } from '../src/serverRestart.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';

let db: DB;
let serverId: number;

const statusOf = () => (getServer(db, serverId) as ServerRow).status;

beforeEach(() => {
  db = openDb(':memory:');
  serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x' });
  markLive(db, serverId);
});

describe('rconRestarter', () => {
  /** No real timers: every test drives the clock itself. */
  const build = (ready: () => Promise<boolean>, quit = async () => {}) => {
    let clock = 0;
    const restarter = rconRestarter({
      quit,
      ready,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      pollMs: 1000,
      timeoutMs: 10_000,
    });
    return restarter;
  };

  it('quits, waits, and reports the box back once it answers', async () => {
    const quit = vi.fn(async () => {});
    let probes = 0;
    const r = build(async () => ++probes >= 3, quit);
    await expect(r.restart(getServer(db, serverId)!)).resolves.toBe(true);
    expect(quit).toHaveBeenCalledOnce();
    // Never probed before the first sleep: the dying process is still
    // listening for a moment and would answer for the server being replaced.
    expect(probes).toBe(3);
  });

  it('treats a dropped quit connection as normal, not a failure', async () => {
    const r = build(async () => true, async () => { throw new Error('connection reset'); });
    await expect(r.restart(getServer(db, serverId)!)).resolves.toBe(true);
  });

  it('keeps waiting through a probe that throws', async () => {
    let probes = 0;
    const r = build(async () => {
      probes++;
      if (probes < 2) throw new Error('ECONNREFUSED');
      return true;
    });
    await expect(r.restart(getServer(db, serverId)!)).resolves.toBe(true);
  });

  it('gives up after the timeout and tells the admins', async () => {
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    try {
      const r = build(async () => false);
      await expect(r.restart(getServer(db, serverId)!)).resolves.toBe(false);
      const problem = seen.find((e) => e.kind === 'problem');
      expect(problem).toBeTruthy();
      expect((problem as { text: string }).text).toMatch(/Dallas .*has not come back/);
      expect((problem as { text: string }).text).toMatch(/Set idle/);
    } finally {
      off();
    }
  });
});

describe('restartsAfterMatch', () => {
  it('is off until an admin turns it on', () => {
    expect(restartsAfterMatch(db, serverId)).toBe(false);
    setRestartAfterMatch(db, serverId, true);
    expect(restartsAfterMatch(db, serverId)).toBe(true);
  });
});

describe('ServerReleaser with a restart', () => {
  const fakeRestarter = (ok: boolean, onCall?: () => void): ServerRestarter => ({
    restart: async () => { onCall?.(); return ok; },
  });

  it('holds the box OUT of the pool until it is back, then makes it idle', async () => {
    setRestartAfterMatch(db, serverId, true);
    const seen: string[] = [];
    const releaser = new ServerReleaser(db, async () => {}, fakeRestarter(true, () => seen.push(statusOf())));

    releaser.release(serverId, { restart: true });
    // Synchronously, before any await: a completing lobby claims 'idle' rows,
    // and a box mid-restart must not be one of them.
    expect(statusOf()).toBe('offline');

    await releaser.settled();
    expect(seen).toEqual(['offline']);
    expect(statusOf()).toBe('idle');
  });

  it('leaves a box that never came back offline, not idle', async () => {
    setRestartAfterMatch(db, serverId, true);
    const releaser = new ServerReleaser(db, async () => {}, fakeRestarter(false));
    releaser.release(serverId, { restart: true });
    await releaser.settled();
    expect(statusOf()).toBe('offline');
  });

  it('does not fire waiters until the box is actually back', async () => {
    setRestartAfterMatch(db, serverId, true);
    const at: string[] = [];
    const releaser = new ServerReleaser(db, async () => {}, fakeRestarter(true));
    releaser.onFreed(() => at.push(statusOf()));
    releaser.release(serverId, { restart: true });
    await releaser.settled();
    // A waiter claims the box. Firing it mid-restart would hand a match a
    // server that is not listening.
    expect(at).toEqual(['idle']);
  });

  it('goes straight to idle, synchronously, when the box is not set to restart', async () => {
    const restart = vi.fn(async () => true);
    const releaser = new ServerReleaser(db, async () => {}, { restart });
    releaser.release(serverId, { restart: true });
    expect(statusOf()).toBe('idle');
    await releaser.settled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('never restarts on a release that did not ask for one', async () => {
    setRestartAfterMatch(db, serverId, true);
    const restart = vi.fn(async () => true);
    const releaser = new ServerReleaser(db, async () => {}, { restart });
    // The boot reconcile and a failed setup release this way, and either may
    // be looking at a box with people on it who are in no match at all.
    releaser.release(serverId);
    expect(statusOf()).toBe('idle');
    await releaser.settled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts after the cleanup, never before it', async () => {
    setRestartAfterMatch(db, serverId, true);
    const order: string[] = [];
    const releaser = new ServerReleaser(
      db,
      async () => { order.push('cleanup'); },
      fakeRestarter(true, () => order.push('restart')),
    );
    releaser.release(serverId, { restart: true });
    await releaser.settled();
    // sm_pug_abort, the password restore and the spec plugin reload all ride
    // on the cleanup connection. Quitting first would lose them.
    expect(order).toEqual(['cleanup', 'restart']);
  });
});
