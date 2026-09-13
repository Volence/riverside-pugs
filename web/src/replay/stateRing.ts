import { STATE } from '../../../src/replayFormat';

/** One state the map colours a ring for. Order in STATE_RINGS is priority:
 *  the first whose bit is set wins, for the ring and the glyph alike. */
export interface StateRing {
  key: 'pinned' | 'incap' | 'ledged' | 'burning' | 'biled';
  bit: number;
  color: string;
  /** The one-letter glyph drawn above the medallion: the colour-blind
   *  channel, so it is in the same table as the colour and cannot drift. */
  glyph: string;
  /** For the Key panel and tooltips. */
  label: string;
}

/**
 * Pinned first because it is the state someone watching needs soonest (a
 * teammate seconds from being carried off), then the two down states, then
 * burning, then biled.
 *
 * Colours, measured with colorDistance.ts under normal vision, protanopia
 * and deuteranopia (stateRing.test.ts enforces the numbers):
 * - pinned is the site red: red means act now, and a capped or pulled
 *   survivor is the one state a teammate can still fix (owner, 2026-09-13:
 *   "something more dramatic if someone's pulled or capped, like red"). It
 *   also gets a breathing halo in draw.ts.
 * - incap and ledged share #e0b654, a gold moved off the site's rating gold
 *   #c9a45c because that sat 13.2 dE from the red. It is 23 from red and 16
 *   from orange, and 10 from infected slot 6's gold, accepted by name.
 * - burning orange clears every rim by 22 or more.
 * - biled purple clears every rim by 47 or more under normal vision and
 *   collapses onto the survivor blues for a dichromat, which no purple can
 *   avoid; the B glyph carries it there.
 */
export const STATE_RINGS: readonly StateRing[] = [
  { key: 'pinned', bit: STATE.PINNED, color: '#de4e40', glyph: 'P', label: 'Pinned' },
  { key: 'incap', bit: STATE.INCAP, color: '#e0b654', glyph: 'X', label: 'Down' },
  { key: 'ledged', bit: STATE.LEDGED, color: '#e0b654', glyph: 'L', label: 'Hanging' },
  { key: 'burning', bit: STATE.BURNING, color: '#ff7a1a', glyph: 'F', label: 'Burning' },
  { key: 'biled', bit: STATE.BILED, color: '#a85cf0', glyph: 'B', label: 'Biled' },
];

/** Rim and face treatment for a dead player. Far from every state colour and
 *  from the ghost brick, so "dead" and "unspawned" cannot be confused. */
export const DEAD_COLOR = '#6d675e';

export function stateRing(state: number): StateRing | null {
  if ((state & STATE.ALIVE) === 0) return null;
  for (const r of STATE_RINGS) if ((state & r.bit) !== 0) return r;
  return null;
}

export function stateRingColor(state: number): string | null {
  return stateRing(state)?.color ?? null;
}

/** The one status marker worth showing on the map. Same walk as the ring, so
 *  they can never disagree about which state won. Kept working for a dead or
 *  ghost record too (returns '') because draw.ts gates on those itself. */
export function statusGlyph(state: number): string {
  for (const r of STATE_RINGS) if ((state & r.bit) !== 0) return r.glyph;
  return '';
}
