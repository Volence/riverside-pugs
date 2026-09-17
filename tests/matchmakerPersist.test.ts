import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer } from '../src/players.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 10 }, (_, i) => `765611980000000${String(i + 10)}`);

class FakeScheduler implements Scheduler {
  timers = new Map<number, { fn: () => void; ms: number }>();
  private n = 1;
  set(fn: () => void, ms: number): number { const id = this.n++; this.timers.set(id, { fn, ms }); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const f = [...this.timers.values()]; this.timers.clear(); f.forEach((x) => x.fn()); }
}

let db: DB;
const setups: number[] = [];
const make = (sched = new FakeScheduler()) => ({
  sched,
  mm: new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async (id) => void setups.push(id), finishMatch: async () => {} },
    scheduler: sched, rng: () => 0,
  }),
});

beforeEach(() => {
  db = openDb(':memory:');
  setups.length = 0;
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: id.slice(-2), avatar: null }, []);
});

describe('matchmaker persistence', () => {
  it('a restart keeps the queue in order', () => {
    const a = make();
    a.mm.join(IDS[2]); a.mm.join(IDS[0]); a.mm.join(IDS[1]);
    a.mm.leave(IDS[0]);
    const b = make();
    b.mm.restore();
    expect(b.mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[2], IDS[1]]);
  });

  it('a restart mid ready check keeps the lobby, who readied, and its id', () => {
    const a = make();
    for (const id of IDS) a.mm.join(id);
    const lobbyId = a.mm.lobbies()[0].id;
    a.mm.ready(IDS[0]);
    a.mm.ready(IDS[3]);

    const b = make();
    b.mm.restore();
    const [lobby] = b.mm.lobbies();
    expect(lobby.id).toBe(lobbyId);
    expect(lobby.snapshot.phase).toBe('ready_check');
    expect(lobby.snapshot.ready.sort()).toEqual([IDS[0], IDS[3]].sort());
    expect(b.mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[8], IDS[9]]);
    expect(b.mm.join(IDS[0]).error).toBe('already in a lobby');
    // The restored lobby still completes.
    for (const id of IDS.slice(0, 8)) b.mm.ready(id);
    for (const id of IDS.slice(0, 8)) b.mm.vote(id, 'dead_air');
    expect(setups).toHaveLength(1);
    expect(b.mm.lobbies()).toEqual([]);
  });

  it('keeps votes in the map vote', () => {
    const a = make();
    for (const id of IDS.slice(0, 8)) a.mm.join(id);
    for (const id of IDS.slice(0, 8)) a.mm.ready(id);
    a.mm.vote(IDS[0], 'no_mercy');
    a.mm.vote(IDS[1], 'no_mercy');
    const b = make();
    b.mm.restore();
    const [lobby] = b.mm.lobbies();
    expect(lobby.snapshot.phase).toBe('map_vote');
    expect(lobby.snapshot.votes).toEqual({ no_mercy: 2 });
  });

  it('resumes the remaining time, with a grace floor for time lost while down', () => {
    const a = make();
    for (const id of IDS.slice(0, 8)) a.mm.join(id);
    // Pretend the process was down past the deadline.
    const row = db.prepare('SELECT json FROM matchmaker_state WHERE id = 1').get() as { json: string };
    const state = JSON.parse(row.json);
    state.lobbies[0].deadline = Date.now() - 60_000;
    db.prepare('UPDATE matchmaker_state SET json = ? WHERE id = 1').run(JSON.stringify(state));

    const sched = new FakeScheduler();
    const b = make(sched);
    b.mm.restore();
    const [timer] = [...sched.timers.values()];
    expect(timer.ms).toBeGreaterThanOrEqual(29_000);
    expect(b.mm.lobbies()[0].snapshot.deadline).toBeGreaterThan(Date.now());
    sched.fireAll();
    expect(b.mm.lobbies()).toEqual([]);
  });

  it('a lobby that ended is not restored', () => {
    const a = make();
    for (const id of IDS.slice(0, 8)) a.mm.join(id);
    for (const id of IDS.slice(0, 8)) a.mm.ready(id);
    for (const id of IDS.slice(0, 8)) a.mm.vote(id, 'dead_air');
    const b = make();
    b.mm.restore();
    expect(b.mm.lobbies()).toEqual([]);
  });

  it('restore on an empty database is a no-op', () => {
    const b = make();
    b.mm.restore();
    expect(b.mm.publicQueue().count).toBe(0);
  });
});
