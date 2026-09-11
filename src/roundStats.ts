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
 *  statKeys.ts is not the whole vocabulary, though. The LIVESTAT line also
 *  carries the five core counters (`ck`, `sidmg`, `sikill`, `ff`, `rev`),
 *  which are COLUMNS on `match_players` rather than registry entries, so
 *  `statDef` returns undefined for every one of them. Consulting the registry
 *  alone dropped all five from every round, which is the worst possible subset
 *  to lose: they are the stats present in every match whether or not
 *  skill_detect is loaded, so on a server without it a survivor half reduced
 *  to almost nothing. WIRE_SIDE below carries their sides explicitly.
 *
 *  Exactly two classes of key are dropped:
 *    - `hp`, which is a LEVEL and not a counter. "How much health did you have
 *      when the map ended" cannot be partitioned between two halves at all:
 *      it is one reading taken at one moment, not an accumulation, so filing
 *      it under either half would be an invention.
 *    - anything in neither statKeys.ts nor WIRE_SIDE. An unrecognised key has
 *      no side to reason about, and filing it under the wrong half would be
 *      worse than omitting it, the same "never fabricate" discipline that
 *      keeps absent stats from ever being rendered as zeros elsewhere in this
 *      codebase.
 *
 *  The whole derivation rests on the two halves of an ordinal holding
 *  opposite `surv_team` values. Nothing in the schema enforces that:
 *  `recordRoundStart` uses `ON CONFLICT DO NOTHING`, and `recordRoundEnd`
 *  only `console.warn`s on a side disagreement before overwriting. So a map
 *  can end up with both its halves recorded as `surv_team = 'a'`. If that
 *  happened and this function still trusted `surv_team`, it would compute
 *  `side = 'survivor'` for team a in both halves and emit the same map-level
 *  stat into both rounds, silent double counting that the per-round
 *  `reliable` column would not reflect. So before assigning sides, every
 *  ordinal with two recorded halves is checked for a genuine partition (one
 *  half `a`, the other `b`); if the two halves agree instead of disagreeing,
 *  every round of that ordinal is forced `reliable: false` in the value this
 *  function returns, on top of whatever `match_rounds.reliable` already
 *  said. This is a derivation-time correction only; the database rows are
 *  never touched.
 *
 *  An ordinal with only one recorded half (map still in progress, or a lost
 *  round-start/round-end datagram) is left alone. There is no second half to
 *  disagree with, so nothing has yet shown the side mapping to be wrong; that
 *  half's own `reliable` value is trusted as-is rather than penalised for an
 *  absence that is expected mid-match.
 */

import type { DB } from './db.js';
import { roundsFor, mapStatsFor, type RoundRow } from './liveView.js';
import { statDef } from './statKeys.js';

/** Sides for the wire keys that are NOT in the stat registry.
 *
 *  These five are the always-present core counters. They live as fixed columns
 *  on `match_players` (si_damage, si_kills, common_kills, ff_dealt, revives)
 *  rather than in the key/value stat table, so statKeys.ts has no entry for
 *  them, yet the plugin's LIVESTAT line sends them by these short names and
 *  recordLiveStat passes them straight through into the snapshot.
 *
 *  All five are survivor-side: common kills, SI damage, SI kills, friendly
 *  fire dealt and revives can only accrue while their owner is a survivor.
 *
 *  `hp` deliberately has NO entry here. It is a level, not a counter (see the
 *  header), so it is dropped rather than partitioned. */
const WIRE_SIDE: Record<string, 'survivor' | 'infected'> = {
  ck: 'survivor',
  sidmg: 'survivor',
  sikill: 'survivor',
  ff: 'survivor',
  rev: 'survivor',
};

/** The side a snapshot key belongs to, or undefined when it has none and must
 *  therefore be dropped. Registry first, then the core counters. */
function sideOfKey(key: string): 'survivor' | 'infected' | undefined {
  return statDef(key)?.side ?? WIRE_SIDE[key];
}

export interface RoundAttribution {
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  /** This half's survivor score, as recorded by ROUND_END. Always a number
   *  because the column is NOT NULL DEFAULT 0, which is exactly why
   *  `endedAt` exists: a 0 here means "they scored nothing" only when
   *  `endedAt` is non-null. */
  score: number;
  /** When ROUND_END closed this half, or null if it never arrived. A consumer
   *  must refuse to render `score` for a round with a null endedAt rather than
   *  showing the column default as a real result. */
  endedAt: string | null;
  reliable: boolean;
  byPlayer: Record<string, Record<string, number>>;
}

export function roundAttribution(
  db: DB, matchId: number, teamOf: Map<string, 'a' | 'b'>,
): RoundAttribution[] {
  const rounds = roundsFor(db, matchId);
  if (rounds.length === 0) return [];
  const byMap = mapStatsFor(db, matchId);

  const byOrdinal = new Map<number, RoundRow[]>();
  for (const r of rounds) {
    const list = byOrdinal.get(r.ordinal);
    if (list) list.push(r); else byOrdinal.set(r.ordinal, [r]);
  }
  // An ordinal's two halves are only a trustworthy partition of the map if
  // they disagree on who held survivor. A lone half (map still in progress)
  // has nothing to disagree with, so it is not flagged.
  const unpartitioned = new Set<number>();
  for (const [ordinal, list] of byOrdinal) {
    if (list.length === 2 && list[0].survTeam === list[1].survTeam) {
      unpartitioned.add(ordinal);
    }
  }

  return rounds.map((r) => {
    const mapStats = byMap.get(r.ordinal) ?? {};
    const byPlayer: Record<string, Record<string, number>> = {};
    for (const [steamid, stats] of Object.entries(mapStats)) {
      const team = teamOf.get(steamid);
      if (!team) continue;
      const side = team === r.survTeam ? 'survivor' : 'infected';
      const kept: Record<string, number> = {};
      for (const [key, value] of Object.entries(stats)) {
        if (sideOfKey(key) === side) kept[key] = value;
      }
      byPlayer[steamid] = kept;
    }
    return {
      ordinal: r.ordinal, half: r.half, survTeam: r.survTeam,
      score: r.score, endedAt: r.endedAt,
      reliable: r.reliable && !unpartitioned.has(r.ordinal), byPlayer,
    };
  });
}
