import type { StatDef } from './api';

export type StatDirection = 'high_good' | 'high_bad' | 'neutral';
export type Mark = 'good' | 'bad';

/** Direction for the five core counters plus hp.
 *
 *  These arrive in the same stat bag as registry keys but are NOT entries in
 *  src/statKeys.ts: they are fixed columns on match_players. The registry
 *  cannot answer for them. This mirrors WIRE_SIDE in src/roundStats.ts, which
 *  solved the identical problem for side rather than for direction. `hp` is a
 *  level rather than a counter, so it is never marked. */
const CORE_DIRECTION: Record<string, StatDirection> = {
  ck: 'high_good',
  sidmg: 'high_good',
  sikill: 'high_good',
  rev: 'high_good',
  ff: 'high_bad',
  hp: 'neutral',
  // boomer_rate is synthesised by deriveLiveStats (format.ts) from
  // boom_successes / boomer_spawns and is not a registry entry either. Left
  // neutral on purpose: the denominator is typically two to four boomer
  // lives, so a marked percentage would be the noisiest column on the page.
  // The underlying boom_successes count is still marked normally.
  boomer_rate: 'neutral',
};

/** How far apart a column has to be before anyone is called an outlier.
 *
 *  The spread (max minus min) must be at least this fraction of the max. At
 *  0.5, seven players on 2 clears and one on 3 marks nobody (spread of 1
 *  against a required 1.5), while one player on 300 friendly fire among others
 *  in the 20s marks loudly. Tunable: the spec leaves the exact value open until
 *  there are enough matches to watch it behave.
 *
 *  The formula (max - min) < threshold * abs(max) assumes every value in the
 *  column is non-negative. Every current stat is a non-negative counter, but a
 *  future signed stat (a net delta, say) could push max toward zero or below
 *  it and silently disable this guard rather than fail loudly. */
export const SPREAD_THRESHOLD = 0.5;

export function directionOf(key: string, defs: StatDef[]): StatDirection {
  const def = defs.find((d) => d.key === key);
  if (def) return def.direction;
  return CORE_DIRECTION[key] ?? 'neutral';
}

/**
 * Which cells in one column stand out, in the column's own row order.
 *
 * Returns one entry per input value: 'good', 'bad', or null for unmarked.
 * Marks BOTH ends, because "fewest clears" is as much a finding as "most
 * skeets". At most two cells are marked, one per end.
 *
 * Two guards, both there to stop the marking asserting more than it can
 * support. Eight players on one map is a small sample and most apparent signal
 * at that size is noise.
 */
export function markColumn(
  values: (number | undefined)[], direction: StatDirection,
): (Mark | null)[] {
  const none: (Mark | null)[] = values.map(() => null);
  if (direction === 'neutral') return none;

  const present = values.filter((v): v is number => v !== undefined);
  // Guard two: a column nobody recorded has no outlier to find. One lone value
  // is not an outlier either, since it has nothing to stand out from.
  if (present.length < 2) return none;

  const max = Math.max(...present);
  const min = Math.min(...present);
  if (max === min) return none;

  // Guard one: a column where everyone is close marks nobody.
  if (max - min < SPREAD_THRESHOLD * Math.abs(max)) return none;

  // High is good means the top is the achievement and the bottom the problem.
  // High is bad inverts both.
  const topMark: Mark = direction === 'high_good' ? 'good' : 'bad';
  const bottomMark: Mark = direction === 'high_good' ? 'bad' : 'good';

  // A tied end has no standout, so that end goes unmarked. The other end is
  // judged independently and can still be marked.
  const topTied = present.filter((v) => v === max).length > 1;
  const bottomTied = present.filter((v) => v === min).length > 1;

  return values.map((v) => {
    if (v === undefined) return null;
    if (v === max && !topTied) return topMark;
    if (v === min && !bottomTied) return bottomMark;
    return null;
  });
}
