import { describe, it, expect } from 'vitest';
import { emptyQueue, RUN_HOLD_MS, STALE_MS, stepAuto, type AutoQueue } from './callouts';
import { CALLOUT_MS, type CastEvent } from '../../../src/cast/types';

const ev = (seq: number, kind: string, actor = 'carl', extra: Partial<CastEvent> = {}): CastEvent =>
  ({ seq, kind, actor, actorTeam: 'a', target: 'stew', value: 25, ...extra });
const kinds = ['skeet', 'dp', 'boom', 'tank_spawn', 'death'];
/** Run the queue over a timeline of feeds: [time, events newest first]. */
function run(steps: [number, CastEvent[]][], opts: { on?: boolean; manualUntil?: number; matchId?: number } = {}): AutoQueue[] {
  let q = emptyQueue();
  return steps.map(([now, events]) => (q = stepAuto(q, {
    matchId: opts.matchId ?? 7, events, on: opts.on ?? true, kinds, manualUntil: opts.manualUntil ?? 0, now,
  })));
}

describe('highlight auto-fire', () => {
  it('never fires what was already in the list when the overlay loaded', () => {
    const [q] = run([[0, [ev(3, 'dp'), ev(2, 'death')]]]);
    expect(q!.showing).toBeNull();
    expect(q!.pending).toHaveLength(0);
  });

  it('fires a new event at once and keeps it up for the callout time', () => {
    const qs = run([[0, []], [1000, [ev(1, 'dp')]], [1000 + CALLOUT_MS - 1, [ev(1, 'dp')]], [1000 + CALLOUT_MS, [ev(1, 'dp')]]]);
    expect(qs[1]!.showing?.title).toBe('DP');
    expect(qs[2]!.showing?.title).toBe('DP');
    expect(qs[3]!.showing).toBeNull();
  });

  it('plays two at once one after the other, oldest first', () => {
    const both = [ev(2, 'death', 'bob'), ev(1, 'tank_spawn', 'tim')];
    const qs = run([[0, []], [1000, both], [1000 + CALLOUT_MS, both]]);
    expect(qs[1]!.showing?.text).toBe('tim becomes tank');
    expect(qs[2]!.showing?.text).toContain('bob was killed');
  });

  it('skips kinds that are not ticked', () => {
    const qs = run([[0, []], [1000, [ev(1, 'incap')]]]);
    expect(qs[1]!.showing).toBeNull();
    expect(qs[1]!.pending).toHaveLength(0);
  });

  it('holds a skeet so a run goes up once, at its final count', () => {
    const one = [ev(1, 'skeet', 'carl', { streak: { count: 1, targets: ['a'] } })];
    // The list folds the run into its newest skeet: seq 1 is gone, seq 2 says Double.
    const two = [ev(2, 'skeet', 'carl', { streak: { count: 2, targets: ['a', 'b'] } })];
    const qs = run([[0, []], [1000, one], [2500, two], [1000 + RUN_HOLD_MS - 1, two], [1000 + RUN_HOLD_MS, two]]);
    expect(qs[1]!.showing).toBeNull();
    expect(qs[2]!.showing).toBeNull();
    expect(qs[2]!.pending).toHaveLength(1);
    expect(qs[3]!.showing).toBeNull();
    expect(qs[4]!.showing?.title).toBe('Double skeet');
    expect(qs[4]!.pending).toHaveLength(0);
  });

  it('waits while the producer has a card up, then plays', () => {
    const qs = run([[0, []], [1000, [ev(1, 'dp')]], [5000, [ev(1, 'dp')]]], { manualUntil: 5000 });
    expect(qs[1]!.showing).toBeNull();
    expect(qs[2]!.showing?.title).toBe('DP');
  });

  it('drops a card that waited too long', () => {
    const qs = run([[0, []], [1000, [ev(1, 'dp')]], [1000 + STALE_MS, [ev(1, 'dp')]]], { manualUntil: 1e12 });
    expect(qs[2]!.pending).toHaveLength(0);
  });

  it('switched off or on a new match it starts over', () => {
    let q = run([[0, []], [1000, [ev(1, 'dp')]]])[1]!;
    expect(q.showing).not.toBeNull();
    q = stepAuto(q, { matchId: 8, events: [ev(9, 'dp')], on: true, kinds, manualUntil: 0, now: 1100 });
    expect(q.showing).toBeNull();
    expect(q.seen).toBe(9);
    q = stepAuto(q, { matchId: 8, events: [ev(10, 'dp'), ev(9, 'dp')], on: false, kinds, manualUntil: 0, now: 1200 });
    expect(q).toEqual(emptyQueue());
  });
});
