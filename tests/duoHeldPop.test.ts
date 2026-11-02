import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import type { Scheduler } from '../src/lobby.js';
import { banPlayer } from '../src/admin/players.js';

/**
 * Adversarial review 2026-11-02: a held pop (a duo behind 7 solos, so 9 in
 * the queue and nothing popping) must pop as soon as the queue CAN pop,
 * whatever made it poppable. Before held pops a queue at 8+ always popped at
 * once, so only a join or an accept ever re-ran the pop check; a leave could
 * never make a pop possible. Now it can.
 */

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number { const id = this.nextId++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const fns = [...this.timers.values()]; this.timers.clear(); fns.forEach((fn) => fn()); }
}

const IDS = Array.from({ length: 12 }, (_, i) => `765611980000002${String(i).padStart(2, '0')}`);
const [A, B] = IDS;
const SOLOS = IDS.slice(2, 9); // 7 solos
let db: DB;
let mm: Matchmaker;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE seasons SET ranks = 1').run();
  mm = new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: new FakeScheduler(),
    rng: () => 0,
  });
});

/** 7 solos, then a duo joins: 9 queued, nothing pops. */
function heldPop() {
  for (const id of SOLOS) mm.join(id);
  const inv = mm.inviteDuo(A, B, 'site');
  if (!inv.ok) throw new Error(inv.error);
  if (!mm.acceptDuo(inv.inviteId, B).ok) throw new Error('accept');
  mm.join(A);
  expect(mm.publicQueue().count).toBe(9);
  expect(mm.lobbies()).toHaveLength(0);
}

describe('a held pop pops once it can', () => {
  it('a solo leaving a held pop lets 6 solos + the duo pop', () => {
    heldPop();
    mm.leave(SOLOS[0]);
    expect(mm.lobbies()).toHaveLength(1);
    expect([...mm.lobbies()[0].snapshot.players].sort()).toEqual([...SOLOS.slice(1), A, B].sort());
  });

  it('staff removing a solo from a held pop lets it pop', () => {
    heldPop();
    mm.staffRemoveFromQueue(SOLOS[3]);
    expect(mm.lobbies()).toHaveLength(1);
  });

  it('a ban of a queued solo in a held pop lets it pop', () => {
    heldPop();
    banPlayer(db, SOLOS[3], IDS[11], 'test', null);
    mm.remove(SOLOS[3]);
    expect(mm.lobbies()).toHaveLength(1);
  });

  it('ending the held duo lets the 8 who are now solos pop', () => {
    heldPop();
    mm.endDuo(B);
    expect(mm.lobbies()).toHaveLength(1);
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual([B]);
  });
});
