import { TUNING } from './constants.js';
import type { Pt } from './geometry.js';

/**
 * The aim prior: how often survivors on this map look at each patch of it.
 *
 * This is the whole answer to "he was just watching the obvious spawn". Spawns
 * are not uniform, players learn the good spots, and so a raw count of "aims
 * where SI actually are" partly measures map knowledge. The prior is built from
 * behaviour rather than hand-labelled, so it already contains every place people
 * stare, and occupancy is then scored as excess over it. Someone exploiting only
 * map knowledge scores zero excess by construction.
 */

export function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function cellOf(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / TUNING.CELL), cy: Math.floor(y / TUNING.CELL) };
}

export function cellCenter(cx: number, cy: number): Pt {
  return { x: cx * TUNING.CELL + TUNING.CELL / 2, y: cy * TUNING.CELL + TUNING.CELL / 2 };
}

/**
 * Every cell inside the aim wedge: within E_DWELL degrees of `yaw`, out to
 * R_MAX.
 *
 * Walked outward rather than tested cell by cell. Testing every cell of a map
 * against every frame is frames times cells, which is hundreds of millions per
 * map; the wedge is under a hundred cells, so walking it is the difference
 * between a backfill that finishes and one that does not.
 *
 * The wedge does not stop at walls, because the analyzer has no geometry. That
 * inflates the prior AND the observation equally, so it costs sensitivity
 * rather than producing false positives.
 */
export function wedgeCells(from: Pt, yaw: number): string[] {
  const seen = new Set<string>();
  const half = TUNING.E_DWELL * Math.PI / 180;
  const step = TUNING.CELL / 2;
  for (let r = step; r <= TUNING.R_MAX; r += step) {
    // Enough angular samples that neighbouring rays stay within half a cell of
    // each other at this radius, so the wedge has no gaps as it widens.
    const arc = 2 * half * r;
    const n = Math.max(3, Math.ceil(arc / step));
    for (let i = 0; i <= n; i++) {
      const a = (yaw * Math.PI / 180) - half + (2 * half * i) / n;
      const c = cellOf(from.x + Math.cos(a) * r, from.y + Math.sin(a) * r);
      seen.add(cellKey(c.cx, c.cy));
    }
  }
  return [...seen];
}

export interface PriorTable {
  frames: number;
  counts: Map<string, number>;
}

export class PriorBuilder implements PriorTable {
  frames = 0;
  counts = new Map<string, number>();

  addSurvivorFrame(from: Pt, yaw: number): void {
    this.frames++;
    for (const k of wedgeCells(from, yaw)) {
      this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    }
  }

  /** Fold another table in. A map's pooled prior is exactly the sum of its
   *  rounds' priors, so pooling is done by adding the SAME per-round table that
   *  `subtractRound` later takes back out. Anything else is two producers of a
   *  number that must agree, and `subtractRound` clamps a disagreement to zero
   *  rather than failing, so the drift would be silent. */
  add(other: PriorTable): void {
    this.frames += other.frames;
    for (const [k, v] of other.counts) this.counts.set(k, (this.counts.get(k) ?? 0) + v);
  }
}

/** Probability a survivor on this map is looking at this cell. Zero for an
 *  empty table, which is what an unseen map must read as. */
export function priorAt(table: PriorTable, key: string): number {
  if (table.frames <= 0) return 0;
  return (table.counts.get(key) ?? 0) / table.frames;
}

/** Leave-one-round-out. Subtracting the round being scored removes the
 *  subject's own frames from their baseline, and their teammates' too, so a
 *  cheater cannot inflate the prior they are measured against and nothing
 *  round-specific leaks into it. Clamped at zero: a caller may hand in a round
 *  that was never pooled. */
export function subtractRound(pool: PriorTable, round: PriorTable): PriorTable {
  const counts = new Map(pool.counts);
  for (const [k, v] of round.counts) {
    counts.set(k, Math.max(0, (counts.get(k) ?? 0) - v));
  }
  return { frames: Math.max(0, pool.frames - round.frames), counts };
}
