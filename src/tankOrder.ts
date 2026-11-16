import { randomInt } from 'node:crypto';
import type { DB } from './db.js';
import { seasonSr } from './rating.js';

/**
 * Tank order for a queue match (owner, 2026-11-15; pug-match 0.3.45,
 * plugin/pug-tankplan.inc). Every player tanks once, and the same SR rank on
 * both teams tanks the same map: each team is ranked by season SR (slot 1 =
 * highest), and one shuffled order of the slots says which slot tanks which
 * map, shared by both teams. A campaign with fewer maps than slots never
 * reaches the last slots of the order, so who sits out is random too.
 *
 * Sent with the roster: the slot as a 4th field on sm_pug_roster, the order as
 * sm_pug_tankorder. Nothing is stored; queue matches are never resumed onto a
 * fresh plugin, and a booking/self-started match uses l4d_tank_control's own
 * "everyone once, random order" pick.
 */

export interface TankRosterRow {
  player_id: string;
  team: 'a' | 'b';
}

/** Slot per player: rank in their own team by SR, highest first, ties by steamid. */
export function tankSlots(rows: readonly (TankRosterRow & { sr: number })[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const team of ['a', 'b'] as const) {
    rows
      .filter((r) => r.team === team)
      .slice()
      .sort((x, y) => y.sr - x.sr || (x.player_id < y.player_id ? -1 : x.player_id > y.player_id ? 1 : 0))
      .forEach((r, i) => out.set(r.player_id, i + 1));
  }
  return out;
}

/** A shuffled order of slots 1..n as digits, e.g. "3142" (Fisher-Yates). */
export function shuffledOrder(n: number, rand: (max: number) => number = randomInt): string {
  const slots = Array.from({ length: Math.max(1, Math.min(n, 9)) }, (_, i) => i + 1);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots.join('');
}

export interface TankPlan {
  slots: Map<string, number>;
  order: string;
}

/** The plan for a match about to be set up, from the season SR of its roster. */
export function planTankOrder(db: DB, matchId: number, roster: readonly TankRosterRow[], rand?: (max: number) => number): TankPlan {
  const m = db.prepare('SELECT season_id FROM matches WHERE id = ?').get(matchId) as { season_id: number } | undefined;
  const seasonId = m?.season_id ?? 0;
  const slots = tankSlots(roster.map((r) => ({ ...r, sr: seasonSr(db, r.player_id, seasonId) })));
  const perTeam = Math.max(...(['a', 'b'] as const).map((t) => roster.filter((r) => r.team === t).length), 1);
  return { slots, order: shuffledOrder(perTeam, rand) };
}
