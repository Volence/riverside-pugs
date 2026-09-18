import { describe, it, expect } from 'vitest';
import { Lobby, voteLocked, type LobbyEvents, type Scheduler } from '../src/lobby.js';

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

describe('voteLocked', () => {
  // The winner is settled when nobody still to vote can change WHICH campaign
  // wins. A runner-up that can only draw level is not settled: a tie is broken
  // at random, so the outcome would still be in play.
  it('is locked once the leader cannot be caught', () => {
    expect(voteLocked(new Map([['a', 5], ['b', 2]]), 1)).toBe(true);
  });

  it('is not locked while the runner-up can draw level', () => {
    expect(voteLocked(new Map([['a', 4], ['b', 3]]), 1)).toBe(false);
  });

  it('is not locked while an unvoted player can overtake', () => {
    expect(voteLocked(new Map([['a', 3], ['b', 1]]), 3)).toBe(false);
  });

  it('is locked when everyone has voted, however close', () => {
    expect(voteLocked(new Map([['a', 4], ['b', 4]]), 0)).toBe(true);
  });

  it('is not locked on an empty tally with votes outstanding', () => {
    expect(voteLocked(new Map(), 8)).toBe(false);
  });

  it('locks a runaway leader even against a campaign with no votes yet', () => {
    // The two left could both pick something untouched, reaching 2 against 6.
    expect(voteLocked(new Map([['a', 6]]), 2)).toBe(true);
    // ...but not when they could reach it: 2 against 2 is a tie, and a tie is
    // broken at random, so the winner is still in play.
    expect(voteLocked(new Map([['a', 2]]), 2)).toBe(false);
  });
});

describe('Lobby vote ends early', () => {
  it('completes as soon as the winner cannot be caught, without waiting out the timer', () => {
    const { lobby, events, sched } = makeLobby();
    for (const p of PLAYERS) lobby.markReady(p);
    // 5 for dead_air, 1 for no_mercy, 2 still to vote: 1 + 2 < 5.
    for (const p of PLAYERS.slice(0, 5)) lobby.castVote(p, 'dead_air');
    lobby.castVote('p6', 'no_mercy');
    expect(events.completed).toHaveLength(1);
    expect(events.completed[0].campaign).toBe('dead_air');
    // and the vote timer was cancelled rather than left to fire
    expect(sched.timers.size).toBe(0);
  });

  it('waits for the timer when the last votes could still change the winner', () => {
    const { lobby, events } = makeLobby();
    for (const p of PLAYERS) lobby.markReady(p);
    // 4 for dead_air, 3 for no_mercy, 1 to go: that vote can force a tie.
    for (const p of PLAYERS.slice(0, 4)) lobby.castVote(p, 'dead_air');
    for (const p of PLAYERS.slice(4, 7)) lobby.castVote(p, 'no_mercy');
    expect(events.completed).toHaveLength(0);
  });
});
