import { describe, it, expect } from 'vitest';
import { sizeFor, choosePlaying, pickSub, onLeave, type SideCandidate } from '../src/sideGameRules.js';

const c = (steamid: string, o: Partial<SideCandidate> = {}): SideCandidate =>
  ({ steamid, connected: true, queuePos: 0, satOut: 0, playedStreak: 0, ...o });

describe('sizeFor', () => {
  it('maps counts to sizes', () => {
    expect([0, 3, 4, 5, 6, 7].map(sizeFor)).toEqual([null, null, 2, 2, 3, 3]);
    expect(sizeFor(8)).toBeNull();
  });
});

describe('choosePlaying', () => {
  it('benches the one who has played longest when nobody has sat out', () => {
    const r = choosePlaying([
      c('a', { queuePos: 0, playedStreak: 3 }), c('b', { queuePos: 1, playedStreak: 1 }),
      c('c', { queuePos: 2, playedStreak: 1 }), c('d', { queuePos: 3, playedStreak: 1 }),
      c('e', { queuePos: 4, playedStreak: 1 }),
    ], 2);
    expect(r.bench).toEqual(['a']);
    expect(r.playing.sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('brings in the longest sitter first', () => {
    const r = choosePlaying([
      c('a', { satOut: 1 }), c('b', { playedStreak: 2, queuePos: 1 }), c('c', { playedStreak: 1, queuePos: 2 }),
      c('d', { playedStreak: 1, queuePos: 3 }), c('e', { playedStreak: 1, queuePos: 4 }),
    ], 2);
    expect(r.playing).toContain('a');
    expect(r.bench).toEqual(['b']);
  });

  it('benches a player who is not connected before anyone who is', () => {
    const r = choosePlaying([c('a', { connected: false, satOut: 5 }), c('b'), c('c'), c('d'), c('e')], 2);
    expect(r.bench).toEqual(['a']);
  });

  it('breaks ties by queue position, earlier plays', () => {
    const r = choosePlaying([c('x', { queuePos: 4 }), c('a', { queuePos: 0 }), c('b', { queuePos: 1 }), c('c', { queuePos: 2 }), c('d', { queuePos: 3 })], 2);
    expect(r.bench).toEqual(['x']);
  });
});

describe('pickSub', () => {
  it('takes the connected longest sitter, or nobody', () => {
    expect(pickSub([c('a', { satOut: 1 }), c('b', { satOut: 2 })])).toBe('b');
    expect(pickSub([c('a', { connected: false, satOut: 9 })])).toBeNull();
    expect(pickSub([])).toBeNull();
  });
});

describe('onLeave', () => {
  it('subs in from the bench when a connected sitter exists', () => {
    const bench = [c('s', { satOut: 1 })];
    expect(onLeave([c('a'), c('b'), c('c'), c('s')], bench)).toEqual({ kind: 'sub', steamid: 's' });
  });
  it('rebuilds smaller at 5 with nobody sitting (6 to 5)', () => {
    expect(onLeave([c('a'), c('b'), c('c'), c('d'), c('e')], [])).toEqual({ kind: 'rebuild', size: 2 });
  });
  it('closes below 4 (a 2v2 loses one)', () => {
    expect(onLeave([c('a'), c('b'), c('c')], [])).toEqual({ kind: 'close' });
  });
  it('rebuilds at the same size when the only sitter is disconnected', () => {
    const bench = [c('s', { connected: false })];
    expect(onLeave([c('a'), c('b'), c('c'), c('s')], bench)).toEqual({ kind: 'rebuild', size: 2 });
  });
});
