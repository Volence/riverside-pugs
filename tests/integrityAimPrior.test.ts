import { describe, it, expect } from 'vitest';
import { TUNING } from '../src/integrity/constants.js';
import {
  cellKey, cellOf, cellCenter, wedgeCells, PriorBuilder, priorAt, subtractRound,
} from '../src/integrity/aimPrior.js';

describe('cells', () => {
  it('floors a position into a grid cell', () => {
    expect(cellOf(0, 0)).toEqual({ cx: 0, cy: 0 });
    expect(cellOf(TUNING.CELL - 1, 0)).toEqual({ cx: 0, cy: 0 });
    expect(cellOf(TUNING.CELL, 0)).toEqual({ cx: 1, cy: 0 });
  });

  it('floors negatives downward rather than toward zero', () => {
    expect(cellOf(-1, -1)).toEqual({ cx: -1, cy: -1 });
  });

  it('round-trips a cell through its centre', () => {
    const c = cellOf(900, -400);
    const mid = cellCenter(c.cx, c.cy);
    expect(cellOf(mid.x, mid.y)).toEqual(c);
  });
});

describe('wedgeCells', () => {
  const origin = { x: 0, y: 0 };

  it('covers cells ahead of the player', () => {
    const keys = wedgeCells(origin, 0);
    expect(keys).toContain(cellKey(...Object.values(cellOf(1000, 0)) as [number, number]));
  });

  it('does not cover cells behind the player', () => {
    const keys = wedgeCells(origin, 0);
    const behind = cellOf(-1000, 0);
    expect(keys).not.toContain(cellKey(behind.cx, behind.cy));
  });

  it('does not reach past R_MAX', () => {
    const keys = wedgeCells(origin, 0);
    const far = cellOf(TUNING.R_MAX * 2, 0);
    expect(keys).not.toContain(cellKey(far.cx, far.cy));
  });

  it('turns with the yaw', () => {
    const north = wedgeCells(origin, 90);
    const target = cellOf(0, 1000);
    expect(north).toContain(cellKey(target.cx, target.cy));
  });

  it('returns no duplicates', () => {
    const keys = wedgeCells(origin, 33);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('PriorBuilder and priorAt', () => {
  it('reports the fraction of frames whose wedge covered a cell', () => {
    const b = new PriorBuilder();
    b.addSurvivorFrame({ x: 0, y: 0 }, 0);   // looks east
    b.addSurvivorFrame({ x: 0, y: 0 }, 180); // looks west
    const east = cellOf(1000, 0);
    expect(b.frames).toBe(2);
    expect(priorAt(b, cellKey(east.cx, east.cy))).toBeCloseTo(0.5);
  });

  it('reports zero for a cell nobody ever looked at', () => {
    const b = new PriorBuilder();
    b.addSurvivorFrame({ x: 0, y: 0 }, 0);
    expect(priorAt(b, cellKey(999, 999))).toBe(0);
  });

  it('reports zero rather than dividing by zero on an empty table', () => {
    expect(priorAt(new PriorBuilder(), cellKey(0, 0))).toBe(0);
  });
});

describe('subtractRound', () => {
  it('removes a round contribution from the pool', () => {
    const pool = new PriorBuilder();
    const round = new PriorBuilder();
    pool.addSurvivorFrame({ x: 0, y: 0 }, 0);
    pool.addSurvivorFrame({ x: 0, y: 0 }, 180);
    round.addSurvivorFrame({ x: 0, y: 0 }, 0);

    const left = subtractRound(pool, round);
    const east = cellOf(1000, 0);
    expect(left.frames).toBe(1);
    expect(priorAt(left, cellKey(east.cx, east.cy))).toBe(0);
  });

  it('never produces a negative count or frame total', () => {
    const pool = new PriorBuilder();
    const round = new PriorBuilder();
    round.addSurvivorFrame({ x: 0, y: 0 }, 0);
    round.addSurvivorFrame({ x: 0, y: 0 }, 0);
    const left = subtractRound(pool, round);
    expect(left.frames).toBe(0);
    for (const v of left.counts.values()) expect(v).toBeGreaterThanOrEqual(0);
  });
});
