/** Per-round stats, DERIVED rather than stored.
 *
 *  This is the load-bearing simplification of the whole replay-capture spec.
 *  An L4D1 versus map is played twice, once per half, with the two pug teams
 *  swapping which one holds survivor. The database only ever writes a
 *  cumulative snapshot of a player's stats as of the end of the MAP
 *  (`match_live_map_stats`), never one per half, so a player who played both
 *  halves of a map has both their survivor and their infected numbers folded
 *  into one snapshot. The obvious conclusion is that splitting that snapshot
 *  back into its two halves is impossible without a new per-round storage
 *  table.
 *
 *  It is not impossible, because of one fact this codebase already commits
 *  to: every stat key in statKeys.ts declares a `side`, and a side's stats
 *  can only physically accrue while their owner is playing that side. A
 *  player cannot rack up `skeets` (survivor) while they are the Hunter, and
 *  cannot rack up `damage_as_si` (infected) while they are a survivor. So for
 *  any player, of the two halves of a map, exactly one is "the half their
 *  team held survivor" and the other is "the half their team held infected"
 *  (`match_rounds.surv_team` says which is which). Their survivor-side keys
 *  can only have accrued in the first, and their infected-side keys can only
 *  have accrued in the second. No per-round snapshot is needed: the map-level
 *  snapshot already carries the information, statKeys.ts just has to be
 *  asked which bucket each key belongs to.
 *
 *  tests/roundStats.test.ts is what holds this claim up, specifically the
 *  first two cases ("puts a survivor stat only in the round its owner held
 *  survivor" and "attributes the opposing team the other way round"), which
 *  assert the split on a player who has both a survivor stat and an infected
 *  stat from the very same map. If those two ever fail against a correct
 *  implementation, this reasoning is wrong and a per-round snapshot table is
 *  needed after all.
 *
 *  Unknown keys are dropped rather than assigned a side. An unrecognised key
 *  has no side to reason about, and filing it under the wrong half would be
 *  worse than omitting it, the same "never fabricate" discipline that keeps
 *  absent stats from ever being rendered as zeros elsewhere in this codebase.
 */

import type { DB } from './db.js';
import { roundsFor, mapStatsFor } from './liveView.js';
import { statDef } from './statKeys.js';

export interface RoundAttribution {
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  reliable: boolean;
  byPlayer: Record<string, Record<string, number>>;
}

export function roundAttribution(
  db: DB, matchId: number, teamOf: Map<string, 'a' | 'b'>,
): RoundAttribution[] {
  const rounds = roundsFor(db, matchId);
  if (rounds.length === 0) return [];
  const byMap = mapStatsFor(db, matchId);

  return rounds.map((r) => {
    const mapStats = byMap.get(r.ordinal) ?? {};
    const byPlayer: Record<string, Record<string, number>> = {};
    for (const [steamid, stats] of Object.entries(mapStats)) {
      const team = teamOf.get(steamid);
      if (!team) continue;
      const side = team === r.survTeam ? 'survivor' : 'infected';
      const kept: Record<string, number> = {};
      for (const [key, value] of Object.entries(stats)) {
        if (statDef(key)?.side === side) kept[key] = value;
      }
      byPlayer[steamid] = kept;
    }
    return {
      ordinal: r.ordinal, half: r.half, survTeam: r.survTeam,
      reliable: r.reliable, byPlayer,
    };
  });
}
