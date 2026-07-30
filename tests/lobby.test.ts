import { describe, it, expect } from 'vitest';
import { Lobby, type LobbyEvents, type Scheduler } from '../src/lobby.js';

const PLAYERS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
const POOL = ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'];

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

function makeLobby(overrides: Partial<LobbyEvents> = {}, rng: () => number = () => 0) {
  const events: LobbyEvents & { completed: any[]; failed: any[] } = {
    completed: [], failed: [],
    onEvent: () => {},
    onComplete: (r) => events.completed.push(r),
    onFail: (ready, notReady) => events.failed.push({ ready, notReady }),
    ...overrides,
  };
  const sched = new FakeScheduler();
  const lobby = new Lobby('lob_1', PLAYERS, { readySeconds: 60, voteSeconds: 30, mapPool: POOL, rng }, events, sched);
  return { lobby, events, sched };
}

describe('ready check', () => {
  it('advances to map_vote when all 8 ready', () => {
    const { lobby } = makeLobby();
    for (const p of PLAYERS) lobby.markReady(p);
    expect(lobby.snapshot().phase).toBe('map_vote');
  });

  it('fails with ready/notReady split when timer fires', () => {
    const { lobby, events, sched } = makeLobby();
    lobby.markReady('p1');
    lobby.markReady('p2');
    sched.fireAll();
    expect(events.failed).toEqual([{ ready: ['p1', 'p2'], notReady: ['p3', 'p4', 'p5', 'p6', 'p7', 'p8'] }]);
    expect(lobby.snapshot().phase).toBe('failed');
  });

  it('rejects ready from non-members', () => {
    const { lobby } = makeLobby();
    expect(lobby.markReady('stranger')).toBe(false);
  });
});

describe('map vote', () => {
  function toVote() {
    const made = makeLobby();
    for (const p of PLAYERS) made.lobby.markReady(p);
    return made;
  }

  it('tallies plurality when all vote', () => {
    const { lobby, events } = toVote();
    for (const p of PLAYERS.slice(0, 5)) lobby.castVote(p, 'dead_air');
    for (const p of PLAYERS.slice(5)) lobby.castVote(p, 'no_mercy');
    expect(events.completed).toEqual([{ players: PLAYERS, campaign: 'dead_air' }]);
    expect(lobby.snapshot().phase).toBe('done');
  });

  it('tallies on timer with partial votes; zero votes -> rng pick', () => {
    const { lobby, events, sched } = toVote();
    sched.fireAll(); // vote timer fires, nobody voted; rng()=0 -> first in pool
    expect(events.completed[0].campaign).toBe('no_mercy');
    expect(lobby.snapshot().phase).toBe('done');
  });

  it('rejects votes for campaigns not in the pool', () => {
    const { lobby } = toVote();
    expect(lobby.castVote('p1', 'crash_course')).toBe(false);
  });

  it('re-voting replaces the previous vote', () => {
    const { lobby, events, sched } = toVote();
    lobby.castVote('p1', 'no_mercy');
    lobby.castVote('p1', 'dead_air');
    sched.fireAll();
    expect(events.completed[0].campaign).toBe('dead_air');
  });
});
