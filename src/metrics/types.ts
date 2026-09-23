import type { Frame } from '../replayFormat.js';

export type Phase = 'all' | 'tank' | 'witch' | 'event' | 'normal';
export type SubPhase = Exclude<Phase, 'all'>;
export const SUB_PHASES: SubPhase[] = ['tank', 'witch', 'event', 'normal'];

/** A rate kept as its parts so pooling rounds weights them correctly. */
export interface Ratio { num: number; den: number }
/** What one metric returns for one round. A phase left out is "not computable". */
export type MetricOut = Partial<Record<Phase, Ratio>>;

export interface RoundKey { matchId: number; ordinal: number; half: 1 | 2 }

export interface RoundEvent {
  kind: string;
  actor: string;
  target: string | null;
  value: number;
  /** Milliseconds since the half went live; -1 when unknown. */
  tMs: number;
}

export interface RoundReplay {
  /** Decoded with real sides and with paused frames removed. */
  frames: Frame[];
  /** Unpaused playing time covered by the frames. */
  durationMs: number;
}

export interface RoundInput {
  key: RoundKey;
  /** match_rounds.started_at (SQLite datetime string), or null before the round went live. */
  startedAt: string | null;
  survTeam: 'a' | 'b';
  reliable: boolean;
  ended: boolean;
  score: number;
  survivorsAlive: number | null;
  /** This round's events, ordered by tMs then seq. */
  events: RoundEvent[];
  marks: { kind: string; tMs: number }[];
  /** player -> stat -> per-round value. Empty when the round predates ROUND_STAT. */
  stats: Map<string, Map<string, number>>;
  /** ROUND_STATS_END arrived for this round. */
  hasStats: boolean;
  /** skill_detect was loaded for this round (meaningful only with hasStats). */
  skillDetect: boolean;
  teamOf: Map<string, 'a' | 'b'>;
  replay: RoundReplay | null;
}

export interface Timeline {
  durationMs: number;
  tank: Interval[];
  witch: Interval[];
  event: Interval[];
  /** Phase at a round time; tank wins over witch over event over normal. */
  phaseAt(tMs: number): SubPhase;
  /** Playing minutes spent in a phase ('all' is the whole round). */
  minutes(p: Phase): number;
}

export interface Interval { from: number; to: number }

export interface RoundCtx extends RoundInput { timeline: Timeline | null }

export type MetricGroup = 'outcomes' | 'tank' | 'witch' | 'hunter' | 'smoker' | 'boomer' | 'si' | 'weapons' | 'pace';

export interface MetricDef {
  id: string;
  group: MetricGroup;
  /** Plain English, shown on the dashboard and later the public page. */
  description: string;
  version: number;
  compute(c: RoundCtx): MetricOut | null;
}
