import type { Phase } from '../types.js';
import type { Verdict } from './stats.js';

export type Origin = 'all' | 'queue' | 'in_game';
export interface SideQuery { patchIds: number[]; origin: Origin; maps: string[] | null }

export interface SideSummary {
  matches: number;
  rounds: number;
  /** Mean of (survivor side mu + infected side mu) / 2 over rounds with ratings. */
  meanMu: number | null;
  /** Mean team rating mismatch: the mean of |survivor side mu - infected
   *  side mu| per round. Absolute, because the teams swap sides every half:
   *  a signed survivor-minus-infected gap cancels to about 0 over a side
   *  whatever the teams are. */
  meanGap: number | null;
  /** Rounds whose context engine is not the current one (kept older
   *  definitions). A round whose computation failed ('!failed' engine) has no
   *  metric rows at all, so it is not counted here. */
  olderEngineRounds: number;
  historical: boolean;
}

export interface CompareRow {
  metric: string;
  group: string;
  description: string;
  phase: Phase;
  a: number | null;
  b: number | null;
  diff: number | null;
  rel: number | null;
  lo: number | null;
  hi: number | null;
  p: number | null;
  verdict: Verdict;
  moreMatches: number | null;
  excludedMaps: string[];
  /** Both sides have data but on no common map, so there is nothing to
   *  compare like for like (the verdict is then no_data). */
  noSharedMaps: boolean;
  nA: number;
  nB: number;
}

export interface CompareResult {
  a: SideSummary;
  b: SideSummary;
  rows: CompareRow[];
  counts: Record<Verdict, number>;
  banners: { skill: string | null; approximate: boolean };
  ms: number;
}

export interface TrendPoint { matchId: number; endedAt: string; patchId: number | null; side: 'a' | 'b'; value: number }
export interface MapBar { map: string; a: number; b: number; roundsA: number; roundsB: number }
export interface ExampleRound { matchId: number; ordinal: number; half: number; map: string | null; value: number }
/** One selected patch's own pooled value (sum of num over sum of den across
 *  its counted rounds), so a side that pools several patches can be read
 *  patch by patch. `value` is null when the patch has no rounds for this
 *  metric and phase. */
export interface PatchValue { patchId: number; label: string; value: number | null; matches: number }
export interface MetricDetail {
  metric: string;
  phase: Phase;
  trend: TrendPoint[];
  boundaries: { patchId: number; label: string; at: string }[];
  perMap: MapBar[];
  /** Every selected patch (either side), oldest first. */
  perPatch: PatchValue[];
  examples: ExampleRound[];
}
