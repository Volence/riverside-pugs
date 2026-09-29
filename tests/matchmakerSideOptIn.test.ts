import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer } from '../src/players.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    fns.forEach((fn) => fn());
  }
}

let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;

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
});

describe('side game opt-in', () => {
  it('only a queued player may opt in', () => {
    expect(mm.setSideOptIn(IDS[0], true).ok).toBe(false);
    mm.join(IDS[0]);
    expect(mm.setSideOptIn(IDS[0], true)).toEqual({ ok: true });
    expect(mm.sideCandidates()).toEqual([IDS[0]]);
    expect(mm.stateFor(IDS[0]).queue.sideOptIn).toBe(true);
  });

  it('keeps queue order and drops a player who leaves', () => {
    for (const id of IDS.slice(0, 3)) { mm.join(id); mm.setSideOptIn(id, true); }
    mm.leave(IDS[1]);
    expect(mm.sideCandidates()).toEqual([IDS[0], IDS[2]]);
    mm.join(IDS[1]);
    expect(mm.isSideOptedIn(IDS[1])).toBe(false);
  });

  it('survives a restore', () => {
    mm.join(IDS[0]); mm.setSideOptIn(IDS[0], true);
    const mm2 = new Matchmaker(db, {
      broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} }, scheduler: sched, rng: () => 0,
    });
    mm2.restore();
    expect(mm2.sideCandidates()).toEqual([IDS[0]]);
  });

  it('keeps opt-ins through a pop and requeues them after a failed ready check', () => {
    for (const id of IDS) { mm.join(id); mm.setSideOptIn(id, true); }
    expect(mm.sideCandidates()).toEqual([]);              // all 8 are in the lobby now
    expect(mm.lobbyOf(IDS[0])?.phase).toBe('ready_check');
    for (const id of IDS.slice(0, 5)) mm.ready(id);
    sched.fireAll();                                       // ready check times out
    expect(mm.sideCandidates()).toEqual(IDS.slice(0, 5));
  });

  it('drops the opt-ins of a completed lobby', () => {
    for (const id of IDS) { mm.join(id); mm.setSideOptIn(id, true); }
    for (const id of IDS) mm.ready(id);
    sched.fireAll();                                       // vote ends
    expect(IDS.some((id) => mm.isSideOptedIn(id))).toBe(false);
  });

  it('tells listeners on every change', () => {
    let n = 0;
    mm.on({ stateChanged: () => { n++; } });
    mm.join(IDS[0]);
    expect(n).toBeGreaterThan(0);
  });
});
