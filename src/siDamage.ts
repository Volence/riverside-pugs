/**
 * "Damage as SI" as the site shows and ranks it (owner, 2026-10-23).
 *
 * The stored `damage_as_si` counts every point of damage an infected player
 * did to survivors, including what only drained an already-incapped
 * survivor's bleedout pool. That part is `dmg_to_incapped`: it reflects no
 * skill, and across Season 0 it was about 28% of the total, enough to reorder
 * the boards. So everything that shows or ranks "Damage as SI" shows the total
 * minus that part. "On incapped" keeps its own column, so nothing is hidden.
 *
 * Stored rows are never rewritten: match_player_stats, the live snapshots and
 * frozen weeks keep the gross figure, and the subtraction happens where a
 * number is read for display or ranking, through the two functions here. The
 * metrics engine has made the same subtraction since it was written
 * (src/metrics/defs/pace.ts).
 *
 * Pure and dependency free, so the web build imports this same file.
 *
 * Apply it ONCE per raw bag. A bag that has already been through
 * withNetDamageAsSi still carries dmg_to_incapped, so a second pass would
 * subtract it again.
 */

export const DAMAGE_AS_SI = 'damage_as_si';
export const DMG_TO_INCAPPED = 'dmg_to_incapped';

/** damage_as_si minus dmg_to_incapped, never below zero. A bag from before
 *  dmg_to_incapped existed has no such key and reads as its gross total. */
export function netDamageAsSi(bag: Readonly<Record<string, number | undefined>>): number {
  const gross = Number(bag[DAMAGE_AS_SI]) || 0;
  const onIncapped = Number(bag[DMG_TO_INCAPPED]) || 0;
  // Rounded to strip float noise when the inputs are averages (45.3 - 12.1
  // is 33.199999999999996); whole numbers pass through unchanged.
  return Math.max(0, Math.round((gross - onIncapped) * 1e6) / 1e6);
}

/** A copy of a raw stat bag with damage_as_si replaced by the net figure.
 *  A bag with no damage_as_si comes back as a plain copy, so a player who
 *  never played infected does not grow a 0 they never had. */
export function withNetDamageAsSi<T extends Record<string, number>>(bag: T): T {
  if (bag[DAMAGE_AS_SI] === undefined) return { ...bag };
  return { ...bag, [DAMAGE_AS_SI]: netDamageAsSi(bag) };
}
