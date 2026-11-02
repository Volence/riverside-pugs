import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker, HOLD_RECHECK_MS } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { getSetting, setSetting } from '../src/settings.js';
import { Queue } from '../src/queue.js';
import type { Scheduler } from '../src/lobby.js';
import { duoHoldBumpsSince, duoPopSkipsSince } from '../scripts/duo-review.js';

/**
 * duo_hold_max_minutes (owner 2026-11-02): a pop held for a duo that does
 * not fit (7 solos ahead of it) waits for one more player, as before, unless
 * staff set a limit. Past the limit it pops anyway and the bumped solo goes
 * to the front. 0, the default, never bumps anyone.
 */

/** Timers that fire when the fake clock passes them. */
class ClockScheduler implements Scheduler {
  t = Date.parse('2026-11-03T00:00:00Z');
  private timers = new Map<number, { fn: () => void; due: number }>();
  private nextId = 1;
  set(fn: () => void, ms: number): number { const id = this.nextId++; this.timers.set(id, { fn, due: this.t + ms }); return id; }
  clear(id: number): void { this.timers.delete(id); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, x]) => x.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].due);
      next[1].fn();
    }
    this.t = end;
  }
}

const MIN = 60 * 1000;
const IDS = Array.from({ length: 12 }, (_, i) => `765611980000004${String(i).padStart(2, '0')}`);
const [A, B] = IDS;
const SOLOS = IDS.slice(2, 9); // 7 solos
const X = IDS[9];
let db: DB;
let sched: ClockScheduler;
let mm: Matchmaker;

function build(): Matchmaker {
  return new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched,
    rng: () => 0,
    now: () => sched.t,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE seasons SET ranks = 1').run();
  sched = new ClockScheduler();
  mm = build();
  const inv = mm.inviteDuo(A, B, 'site');
  if (!inv.ok) throw new Error(inv.error);
  if (!mm.acceptDuo(inv.inviteId, B).ok) throw new Error('accept');
});

/** 7 solos, then the duo: 9 queued, held. */
function hold() {
  for (const id of SOLOS) mm.join(id);
  mm.join(A);
  expect(mm.publicQueue().count).toBe(9);
  expect(mm.lobbies()).toHaveLength(0);
}

const queued = () => mm.publicQueue().players.map((p) => p.steamid);
const popped = () => [...mm.lobbies()[0].snapshot.players].sort();

describe('duo hold limit', () => {
  it('defaults to 0, which never bumps a solo however long the pop is held', () => {
    expect(getSetting(db, 'duo_hold_max_minutes')).toBe('0');
    hold();
    sched.advance(3 * 60 * MIN);
    expect(mm.lobbies()).toHaveLength(0);
    expect(mm.publicQueue().count).toBe(9);
  });

  it('pops after N minutes held, the duo in, the last solo bumped to the front', () => {
    setSetting(db, 'duo_hold_max_minutes', '5');
    hold();
    sched.advance(5 * MIN - 1000);
    expect(mm.lobbies()).toHaveLength(0);
    sched.advance(1000);
    expect(mm.lobbies()).toHaveLength(1);
    expect(popped()).toEqual([...SOLOS.slice(0, 6), A, B].sort());
    expect(queued()).toEqual([SOLOS[6]]);
    mm.join(X);
    expect(queued()).toEqual([SOLOS[6], X]);
    expect(duoHoldBumpsSince(db, 0)).toEqual({ pops: 1, bumpedSolos: 1, avgHeldMinutes: 5 });
    expect(duoPopSkipsSince(db, 0)).toBe(0);
  });

  it('a hold that resolves on its own before N resets the clock', () => {
    setSetting(db, 'duo_hold_max_minutes', '5');
    hold();
    sched.advance(3 * MIN);
    mm.leave(A); // the duo leaves: 7 queued, not held
    expect(mm.publicQueue().count).toBe(7);
    sched.advance(1 * MIN);
    mm.join(A); // held again from here
    sched.advance(4 * MIN);
    expect(mm.lobbies()).toHaveLength(0);
    sched.advance(1 * MIN);
    expect(mm.lobbies()).toHaveLength(1);
  });

  it('fewer than 8 queued never forces anything', () => {
    setSetting(db, 'duo_hold_max_minutes', '1');
    for (const id of SOLOS.slice(0, 5)) mm.join(id);
    mm.join(A);
    expect(mm.publicQueue().count).toBe(7);
    sched.advance(60 * MIN);
    expect(mm.lobbies()).toHaveLength(0);
    expect(mm.publicQueue().count).toBe(7);
  });

  it('a setting change applies on the next check, without anyone joining', () => {
    hold();
    sched.advance(10 * MIN);
    expect(mm.lobbies()).toHaveLength(0);
    setSetting(db, 'duo_hold_max_minutes', '5');
    sched.advance(HOLD_RECHECK_MS);
    expect(mm.lobbies()).toHaveLength(1);
    expect(queued()).toEqual([SOLOS[6]]);
  });

  it('a restart keeps the hold clock', () => {
    setSetting(db, 'duo_hold_max_minutes', '5');
    hold();
    sched.advance(4 * MIN);
    mm = build();
    mm.restore();
    expect(mm.lobbies()).toHaveLength(0);
    sched.advance(1 * MIN);
    expect(mm.lobbies()).toHaveLength(1);
  });
});

describe('Queue.takeBatchBumping', () => {
  const partner = (pairs: [string, string][]) => (id: string) => {
    for (const [x, y] of pairs) { if (x === id) return y; if (y === id) return x; }
    return null;
  };

  it('bumps the latest solo for the first duo that does not fit, and moves it to the front', () => {
    const q = new Queue();
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 'a', 'b', 'c', 'd']) q.join(id);
    const r = q.takeBatchBumping(8, partner([['a', 'b'], ['c', 'd']]));
    expect(r.taken).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 'a', 'b']);
    expect(r.bumped).toEqual(['s7']);
    expect(q.list()).toEqual(['s7', 'c', 'd']);
  });

  it('takes nothing when even bumping cannot make a full pop', () => {
    const q = new Queue();
    for (const id of ['s1', 's2', 'a', 'b']) q.join(id);
    expect(q.takeBatchBumping(8, partner([['a', 'b']]))).toEqual({ taken: [], bumped: [] });
    expect(q.list()).toEqual(['s1', 's2', 'a', 'b']);
  });
});
