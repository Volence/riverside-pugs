import { describe, it, expect } from 'vitest';
import type { Frame } from '../../../src/replayFormat';
import { STATE } from '../../../src/replayFormat';
import type { TimelineEntry, TimelineEvent } from './timeline';
import {
  BURSTS, BurstClock, MARKER_KINDS, actorPosition, eventPosition, markerEntries, markerKind, markerKindsPresent,
  pinnersAt, witchStartledAt,
} from './markers';

const ev = (seq: number, tMs: number, event: string, actor: string, target: string | null, value = 0): TimelineEvent =>
  ({ seq, tMs, kind: 'event', event, actor, target, value });
const chat = (seq: number, tMs: number, actor: string): TimelineEntry =>
  ({ seq, tMs, kind: 'chat', actor, team: 'survivor', text: 'hi' });

const T: TimelineEntry[] = [
  ev(1, 1000, 'boom', 'B', 'A'),
  ev(2, 2000, 'dp', 'H', 'C', 25),
  chat(3, 2500, 'A'),
  ev(4, 3000, 'boom', 'B', 'C'),
  ev(5, 4000, 'ff', 'A', 'C', 12),
  ev(6, 5000, 'si_spawn', 'H', null, 3),
  ev(7, 6000, 'death', 'A', 'H'),
  ev(8, 7000, 'revive', 'C', 'A'),
];

describe('MARKER_KINDS', () => {
  it('maps every mapped kind to a letter and a colour, and leaves spawns unmapped', () => {
    for (const k of ['boom', 'dp', 'skeet', 'cleared', 'incap', 'death', 'pinned', 'tank_death', 'witch_aggro', 'witch_killed', 'car_alarm', 'ff', 'revive']) {
      expect(markerKind(k)).toBeTruthy();
    }
    expect(markerKind('si_spawn')).toBeNull();
    expect(markerKind('tank_spawn')).toBeNull();
    expect(markerKind('tank_take')).toBeNull();
  });

  it('excludes ff and revive from All events', () => {
    expect(markerKind('ff')!.inAll).toBe(false);
    expect(markerKind('revive')!.inAll).toBe(false);
    expect(markerKind('boom')!.inAll).toBe(true);
  });
});

describe('markerKindsPresent', () => {
  it('lists the kinds in this timeline with counts, in table order', () => {
    expect(markerKindsPresent(T).map((k) => [k.kind.kind, k.count])).toEqual([
      ['boom', 2], ['dp', 1], ['death', 1], ['ff', 1], ['revive', 1],
    ]);
  });
});

describe('markerEntries', () => {
  it('"all" for everyone is every inAll kind, no chat, no spawns, no ff', () => {
    expect(markerEntries(T, 'all', null).map((e) => e.seq)).toEqual([1, 2, 4, 7]);
  });
  it('a kind narrows to that kind, including ones outside All', () => {
    expect(markerEntries(T, 'boom', null).map((e) => e.seq)).toEqual([1, 4]);
    expect(markerEntries(T, 'ff', null).map((e) => e.seq)).toEqual([5]);
  });
  it('a player narrows to events they were actor or target of, in round order', () => {
    expect(markerEntries(T, 'all', 'C').map((e) => e.seq)).toEqual([2, 4]);
    expect(markerEntries(T, 'boom', 'C').map((e) => e.seq)).toEqual([4]);
    expect(markerEntries(T, 'all', 'A').map((e) => e.seq)).toEqual([1, 7]);
  });
  it('an empty selected string (unrostered slot) selects nothing', () => {
    expect(markerEntries(T, 'all', '')).toEqual([]);
  });
});

const sample = (slot: number, x: number, state = STATE.PRESENT | STATE.ALIVE) => ({
  slot, x, y: 10 * slot, z: 0, yaw: 0, pitch: 0, state, health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
});
const frame = (tMs: number, xs: number[]): Frame => ({
  tMs, players: xs.map((x, i) => sample(i, x)), entities: [], offset: 0,
} as Frame);
const FR = [frame(0, [0, 100, 200, 300, 400, 500, 600, 700]), frame(1000, [10, 110, 210, 310, 410, 510, 610, 710])];
const SLOTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

describe('eventPosition', () => {
  it('is the target position for a target-first kind, interpolated at the event time', () => {
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'boom', 'F', 'C'))).toEqual({ x: 205, y: 20, z: 0 });
  });
  it('is the actor position when there is no target', () => {
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'car_alarm', 'B', null))).toEqual({ x: 105, y: 10, z: 0 });
  });
  it('falls back to the actor when the target is not in the roster, and null when neither is', () => {
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'dp', 'H', 'nobody'))).toEqual({ x: 705, y: 70, z: 0 });
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'dp', 'x', 'y'))).toBeNull();
    expect(eventPosition([], SLOTS, ev(1, 500, 'dp', 'H', 'C'))).toBeNull();
  });
  it('treats an empty slot record as unresolvable', () => {
    const empty = frame(0, [0, 0, 0, 0, 0, 0, 0, 0]);
    empty.players[2].state = 0;
    expect(eventPosition([empty], SLOTS, ev(1, 0, 'boom', 'F', 'C'))).toBeNull();
  });
  it('actorPosition returns the actor position only', () => {
    expect(actorPosition(FR, SLOTS, ev(1, 500, 'dp', 'H', 'C'))).toEqual({ x: 705, y: 70, z: 0 });
  });
});

describe('pinnersAt', () => {
  const P: TimelineEntry[] = [
    ev(1, 1000, 'pinned', 'H', 'A'),
    ev(2, 1500, 'pinned', 'S', 'C'),
    ev(3, 2000, 'cleared', 'B', 'A'),
    ev(4, 3000, 'pinned', 'H', 'A'),
  ];
  it('names the most recent pinner of each victim at or before the time', () => {
    expect([...pinnersAt(P, 1600)]).toEqual([['A', 'H'], ['C', 'S']]);
    expect([...pinnersAt(P, 3500)]).toEqual([['A', 'H'], ['C', 'S']]);
    expect([...pinnersAt(P, 500)]).toEqual([]);
  });
});

describe('witchStartledAt', () => {
  const W: TimelineEntry[] = [ev(1, 1000, 'witch_aggro', 'A', null), ev(2, 5000, 'witch_killed', 'B', null)];
  it('is true between the startle and the kill, false before and after', () => {
    expect(witchStartledAt(W, 500)).toBe(false);
    expect(witchStartledAt(W, 3000)).toBe(true);
    expect(witchStartledAt(W, 6000)).toBe(false);
    expect(witchStartledAt([], 3000)).toBe(false);
  });
});

describe('BurstClock', () => {
  it('starts a burst when the playhead crosses an event during a small forward step, and ages it out', () => {
    const c = new BurstClock();
    expect(c.advance(900, 0, T)).toEqual([]);
    const a = c.advance(1100, 16, T);
    expect(a.map((b) => b.entry.seq)).toEqual([1]);
    expect(a[0].style).toBe(BURSTS.boom);
    expect(a[0].startedAt).toBe(16);
    // Still alive inside its life, gone after.
    expect(c.advance(1200, 16 + BURSTS.boom.lifeMs - 1, T)).toHaveLength(1);
    expect(c.advance(1300, 16 + BURSTS.boom.lifeMs + 1, T)).toHaveLength(0);
  });
  it('does not replay bursts across a seek, forward or back', () => {
    const c = new BurstClock();
    c.advance(900, 0, T);
    expect(c.advance(5000, 16, T)).toEqual([]);      // jump forward past 1, 2, 4
    expect(c.advance(1500, 32, T)).toEqual([]);      // jump back
    expect(c.advance(2100, 48, T).map((b) => b.entry.seq)).toEqual([2]);
  });
  it('ignores kinds with no burst and chat', () => {
    const c = new BurstClock();
    c.advance(4900, 0, T);
    expect(c.advance(5100, 16, T)).toEqual([]);     // si_spawn
  });
});
