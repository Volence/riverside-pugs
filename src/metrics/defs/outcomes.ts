import { SUB_PHASES, type MetricDef, type MetricOut, type RoundCtx } from '../types.js';
import { single } from '../kit.js';

const finished = (c: RoundCtx) => c.reliable && c.ended && c.survivorsAlive !== null;

export const defs: MetricDef[] = [
  {
    id: 'round.saferoom', group: 'outcomes', version: 1,
    description: 'Share of rounds where at least one survivor reached the saferoom.',
    public: { label: 'Rounds where survivors reached the saferoom' },
    compute: (c) => (finished(c) ? single(c.survivorsAlive! > 0 ? 1 : 0) : null),
  },
  {
    id: 'round.survivors_alive', group: 'outcomes', version: 1,
    description: 'Survivors still standing when the round ended (0 is a wipe).',
    compute: (c) => (finished(c) ? single(c.survivorsAlive!) : null),
  },
  {
    id: 'round.score', group: 'outcomes', version: 1,
    description: 'Survivor score for the round.',
    public: { label: 'Survivor distance score' },
    compute: (c) => (c.reliable && c.ended ? single(c.score) : null),
  },
  {
    id: 'round.score_on_wipe', group: 'outcomes', version: 1,
    description: 'Survivor score on rounds that ended in a wipe, a stand-in for how far a wiped team got.',
    compute: (c) => (finished(c) && c.survivorsAlive === 0 ? single(c.score) : null),
  },
  {
    id: 'round.length_min', group: 'outcomes', version: 1,
    description: 'Playing minutes in the round, pauses excluded.',
    public: { label: 'Round length' },
    compute: (c) => (c.timeline ? single(c.timeline.minutes('all')) : null),
  },
  {
    id: 'round.phase_share', group: 'outcomes', version: 1,
    description: 'Share of playing time spent in each phase (tank alive, witch near, event, normal).',
    compute: (c) => {
      if (!c.timeline) return null;
      const all = c.timeline.minutes('all');
      if (all <= 0) return null;
      const out: MetricOut = {};
      for (const p of SUB_PHASES) out[p] = { num: c.timeline.minutes(p), den: all };
      return out;
    },
  },
];
