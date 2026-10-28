import { STATE, type Frame } from '../replayFormat.js';

/**
 * Position-to-progress lookup for halves without data feeds. Learned per map
 * from halves that do have feeds: each sample is where the furthest survivor
 * stood and the route progress known at that moment.
 */

/** Grid cell edge, in game units. */
const CELL = 128;
/** How far (in cells, Chebyshev) a query looks for a filled cell. */
const REACH = 3;

export interface ProgressMap {
  map: string;
  /** "ix,iy,iz" -> median progress of the furthest survivor seen in that cell. */
  cells: Record<string, number>;
}

const cellOf = (v: number): number => Math.floor(v / CELL);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildProgressMap(
  map: string,
  samples: { x: number; y: number; z: number; prog: number }[],
): ProgressMap {
  const byCell = new Map<string, number[]>();
  for (const s of samples) {
    const key = `${cellOf(s.x)},${cellOf(s.y)},${cellOf(s.z)}`;
    const list = byCell.get(key);
    if (list) list.push(s.prog); else byCell.set(key, [s.prog]);
  }
  const cells: Record<string, number> = {};
  for (const [k, v] of byCell) cells[k] = median(v);
  return { map, cells };
}

/** Progress at a position: its own cell, else the nearest filled cell within
 *  REACH cells on every axis (ties by distance between cell indices), else null. */
export function progressAt(pm: ProgressMap, x: number, y: number, z: number): number | null {
  const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
  const exact = pm.cells[`${cx},${cy},${cz}`];
  if (exact !== undefined) return exact;
  let best: number | null = null;
  let bestD = Infinity;
  for (let dx = -REACH; dx <= REACH; dx++) {
    for (let dy = -REACH; dy <= REACH; dy++) {
      for (let dz = -REACH; dz <= REACH; dz++) {
        const v = pm.cells[`${cx + dx},${cy + dy},${cz + dz}`];
        if (v === undefined) continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = v; }
      }
    }
  }
  return best;
}

/** The furthest progress among alive survivors (incapped ones count: they
 *  stand at a real position), or null when none is on mapped ground. */
export function furthestProg(pm: ProgressMap, frame: Frame): number | null {
  let best: number | null = null;
  for (const p of frame.players) {
    if (p.infected !== false || (p.state & STATE.ALIVE) === 0) continue;
    const v = progressAt(pm, p.x, p.y, p.z);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}
