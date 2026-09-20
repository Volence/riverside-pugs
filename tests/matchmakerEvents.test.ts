import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker, type MatchmakerListener } from '../src/matchmaker.js';
import { upsertPlayer } from '../src/players.js';
import { Hub } from '../src/ws.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void): number { const id = this.nextId++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const fns = [...this.timers.values()]; this.timers.clear(); fns.forEach((fn) => fn()); }
}

describe('Hub.subscribe', () => {
  it('delivers every broadcast until unsubscribed', () => {
    const hub = new Hub();
    const seen: string[] = [];
    const off = hub.subscribe((e) => seen.push(e));
    hub.broadcast('refresh');
    hub.broadcast('live');
    off();
    hub.broadcast('refresh');
    expect(seen).toEqual(['refresh', 'live']);
  });

  it('a throwing subscriber does not stop the others', () => {
    const hub = new Hub();
    const seen: string[] = [];
    hub.subscribe(() => { throw new Error('boom'); });
    hub.subscribe((e) => seen.push(e));
    hub.broadcast('refresh');
    expect(seen).toEqual(['refresh']);
  });
});

describe('Matchmaker lobby events', () => {
  let db: DB;
  let mm: Matchmaker;
  let sched: FakeScheduler;
  let log: string[];

  beforeEach(() => {
    db = openDb(':memory:');
    for (const id of IDS) upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []);
    sched = new FakeScheduler();
    mm = new Matchmaker(db, {
      broadcast: () => {},
      orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
      scheduler: sched,
      rng: () => 0,
    });
    log = [];
    const listener: MatchmakerListener = {
      lobbyStarted: (id, players) => log.push(`started ${id} ${players.length}`),
      lobbyCompleted: (id, matchId) => log.push(`completed ${id} ${matchId}`),
      lobbyFailed: (id, ready, notReady) => log.push(`failed ${id} ${ready.length} ${notReady.length}`),
    };
    mm.on(listener);
  });

  it('reports start and completion with the created match id', () => {
    for (const id of IDS) mm.join(id);
    const [lobby] = mm.lobbies();
    expect(lobby.snapshot.players).toHaveLength(8);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    const match = db.prepare('SELECT id FROM matches').get() as { id: number };
    expect(log).toEqual([`started ${lobby.id} 8`, `completed ${lobby.id} ${match.id}`]);
    expect(mm.lobbies()).toEqual([]);
  });

  it('reports failure with who did not ready', () => {
    for (const id of IDS) mm.join(id);
    const [lobby] = mm.lobbies();
    mm.ready(IDS[0]);
    sched.fireAll();
    expect(log[1]).toBe(`failed ${lobby.id} 1 7`);
    expect(mm.lastFailure(lobby.id)).toEqual({ ready: [IDS[0]], notReady: IDS.slice(1) });
  });

  // The failure used to be announced by editing the lobby card in #queue-here.
  // That now goes to the admin channel instead (owner, 2026-09-20: keep the
  // queue channel to queues), so the people it actually happened to need
  // telling somewhere. This is what the Play page reads.
  describe('lobby notice', () => {
    const fail = () => {
      for (const id of IDS) mm.join(id);
      mm.ready(IDS[0]);
      mm.ready(IDS[1]);
      sched.fireAll();
    };

    it('tells everyone who was in the lobby what happened, and who was missing', () => {
      fail();
      const mine = mm.stateFor(IDS[0]).lobbyNotice!;
      expect(mine.youWereReady).toBe(true);
      expect(mine.notReady.map((p) => p.steamid)).toEqual(IDS.slice(2));

      // And the people who missed it are told they were the reason.
      expect(mm.stateFor(IDS[3]).lobbyNotice!.youWereReady).toBe(false);
    });

    it('says nothing to someone who was never in that lobby', () => {
      fail();
      const stranger = '76561198000000999';
      upsertPlayer(db, { steamid: stranger, name: 'x', avatar: null }, []);
      expect(mm.stateFor(stranger).lobbyNotice).toBeNull();
    });

    it('clears on dismiss', () => {
      fail();
      mm.dismissNotice(IDS[0]);
      expect(mm.stateFor(IDS[0]).lobbyNotice).toBeNull();
      // One player dismissing is not everyone dismissing.
      expect(mm.stateFor(IDS[1]).lobbyNotice).not.toBeNull();
    });

    it('clears when they queue again, so it cannot outlive the thing it is about', () => {
      fail();
      // The ready players are requeued at the front, so leave and rejoin.
      mm.leave(IDS[0]);
      mm.join(IDS[0]);
      expect(mm.stateFor(IDS[0]).lobbyNotice).toBeNull();
    });
  });

  it('lobby ids are unique across Matchmaker instances, so a restart never reuses one', () => {
    for (const id of IDS) mm.join(id);
    const first = mm.lobbies()[0].id;
    const mm2 = new Matchmaker(db, {
      broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
      scheduler: new FakeScheduler(), rng: () => 0,
    });
    for (const id of IDS) mm2.join(id);
    expect(mm2.lobbies()[0].id).not.toBe(first);
  });

  it('a throwing listener does not break matchmaking', () => {
    mm.on({ lobbyStarted: () => { throw new Error('boom'); } });
    for (const id of IDS) mm.join(id);
    expect(mm.lobbies()).toHaveLength(1);
  });
});
