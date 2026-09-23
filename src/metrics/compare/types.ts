import type { Phase } from '../types.js';
import type { Verdict } from './stats.js';

export type Origin = 'all' | 'queue' | 'in_game';
export interface SideQuery { patchIds: number[]; origin: Origin; maps: string[] | null }

export interface SideSummary {
  matches: number;
  rounds: number;
  /** Mean of (survivor side mu + infected side mu) / 2 over rounds with ratings. */
  meanMu: number | null;
  /** Mean of (survivor side mu - infected side mu). */
  meanGap: number | null;
  /** Rounds whose context engine is not the current one (kept older definitions). */
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
export interface MetricDetail {
  metric: string;
  phase: Phase;
  trend: TrendPoint[];
  boundaries: { patchId: number; label: string; at: string }[];
  perMap: MapBar[];
  examples: ExampleRound[];
}
