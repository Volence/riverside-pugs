import { describe, it, expect } from 'vitest';
import {
  ALT_RULE,
  HR1,
  fullPoints,
  survivorPoints,
  halfParts,
  compareMatch,
  type AltRaw,
  type AltHalf,
  type SurvivorState,
} from '../src/altScore.js';

const ZERO: AltRaw = { ws: 0, wt: 0, wr: 0, ts: 0, tt: 0, tr: 0, ds: 0, dt: 0, dr: 0 };
const PERFECT: AltRaw = { ws: 400, wt: 200, wr: 240, ts: 400, tt: 200, tr: 240, ds: 400, dt: 200, dr: 240 };

function up(solid: number, temp: number, pillsHeld: boolean, reviveStore: number): SurvivorState {
  return { state: 'up', solid, temp, pillsHeld, reviveStore };
}

describe('hr1 constants', () => {
  it('has the rule id and weights', () => {
    expect(ALT_RULE).toBe('hr1');
    expect(HR1).toEqual({
      pills: 0.25, revives: 0.25, walkPool: 700, tankPool: 300, doorPool: 500,
      pillStore: 50, reviveStore: 60, teamSize: 4,
    });
  });
});

describe('fullPoints', () => {
  it('is 127.5 for a fresh survivor under hr1', () => {
    expect(fullPoints()).toBe(127.5);
  });
});

describe('survivorPoints', () => {
  it('scores standing survivors as solid + 0.25 x (temp + held pills + revive store)', () => {
    expect(survivorPoints(up(100, 0, true, 60))).toBe(127.5);
    expect(survivorPoints(up(100, 0, false, 60))).toBe(115);
    expect(survivorPoints(up(50, 50, false, 60))).toBe(77.5);
    expect(survivorPoints(up(1, 0, false, 60))).toBe(16);
    expect(survivorPoints(up(1, 30, false, 0))).toBe(8.5);
    expect(survivorPoints(up(1, 0, false, 0))).toBe(1);
  });

  it('pays nothing for the get-downed trick (revive spent, temp gained)', () => {
    expect(survivorPoints(up(1, 0, false, 60))).toBe(16);
    expect(survivorPoints(up(1, 30, false, 30))).toBe(16);
  });

  it('counts no solid health while down', () => {
    expect(survivorPoints({ state: 'down', solid: 0, temp: 0, pillsHeld: false, reviveStore: 60 })).toBe(15);
    expect(survivorPoints({ state: 'down', solid: 80, temp: 0, pillsHeld: false, reviveStore: 60 })).toBe(15);
  });

  it('is 0 when dead', () => {
    expect(survivorPoints({ state: 'dead', solid: 100, temp: 20, pillsHeld: true, reviveStore: 60 })).toBe(0);
  });
});

describe('halfParts', () => {
  it('gives the full pools for a perfect half', () => {
    expect(halfParts(PERFECT, 1, 1)).toEqual({ walk: 700, tank: 300, door: 500, total: 1500 });
  });

  it('applies the walk and door multipliers', () => {
    expect(halfParts(PERFECT, 1.15, 1.75)).toEqual({ walk: 805, tank: 300, door: 875, total: 1980 });
  });

  it('is all zeros for an all-zero raw', () => {
    expect(halfParts(ZERO, 1, 1)).toEqual({ walk: 0, tank: 0, door: 0, total: 0 });
  });

  it('follows the weight set it is given', () => {
    const w = { ...HR1, pills: 0.5 };
    const perfectForW: AltRaw = { ...PERFECT };
    expect(halfParts(perfectForW, 1, 1, w)).toEqual({ walk: 700, tank: 300, door: 500, total: 1500 });

    const partial: AltRaw = { ws: 200, wt: 100, wr: 0, ts: 200, tt: 100, tr: 0, ds: 200, dt: 100, dr: 0 };
    expect(halfParts(partial, 1, 1, w)).not.toEqual(halfParts(partial, 1, 1));
  });
});

describe('compareMatch', () => {
  function halves(count: number, aTotal: AltRaw, bTotal: AltRaw): AltHalf[] {
    const out: AltHalf[] = [];
    for (let i = 0; i < count; i++) {
      const survTeam = i % 2 === 0 ? 'a' : 'b';
      out.push({
        ordinal: Math.floor(i / 2) + 1,
        half: (i % 2) + 1,
        survTeam,
        raw: survTeam === 'a' ? aTotal : bTotal,
        walkMult: 1,
        doorMult: 1,
      });
    }
    return out;
  }

  it('flags a match whose alt winner differs from the real winner', () => {
    const m = compareMatch(halves(8, ZERO, PERFECT), 8, 'a');
    expect(m).toEqual({ altA: 0, altB: 6000, altWinner: 'b', complete: true, differs: true });
  });

  it('agrees when the real winner matches', () => {
    const m = compareMatch(halves(8, ZERO, PERFECT), 8, 'b');
    expect(m.differs).toBe(false);
  });

  it('is incomplete with differs null when halves are missing', () => {
    const m = compareMatch(halves(7, ZERO, PERFECT), 8, 'a');
    expect(m.complete).toBe(false);
    expect(m.differs).toBeNull();
  });

  it('has differs null when the real winner is unknown', () => {
    const m = compareMatch(halves(8, ZERO, PERFECT), 8, null);
    expect(m.complete).toBe(true);
    expect(m.differs).toBeNull();
  });

  it('is incomplete for a match with no real halves', () => {
    expect(compareMatch([], 0, 'a').complete).toBe(false);
  });

  it('calls equal totals a draw', () => {
    const m = compareMatch(halves(8, PERFECT, PERFECT), 8, 'draw');
    expect(m.altA).toBe(6000);
    expect(m.altB).toBe(6000);
    expect(m.altWinner).toBe('draw');
    expect(m.differs).toBe(false);
  });

  it('applies each half multiplier', () => {
    const hs: AltHalf[] = [
      { ordinal: 1, half: 1, survTeam: 'a', raw: PERFECT, walkMult: 1.15, doorMult: 1.75 },
      { ordinal: 1, half: 2, survTeam: 'b', raw: PERFECT, walkMult: 1, doorMult: 1 },
    ];
    const m = compareMatch(hs, 2, 'b');
    expect(m).toMatchObject({ altA: 1980, altB: 1500, altWinner: 'a', complete: true, differs: true });
  });
});
