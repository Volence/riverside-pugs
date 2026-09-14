import { describe, it, expect } from 'vitest';
import { BOX_COLUMNS, boxScore, columnsPresent } from './boxScore';
import type { TimelineEntry } from './timeline';

const T: TimelineEntry[] = [
  { seq: 1, tMs: 10000, kind: 'event', event: 'pinned', actor: 'H', target: 'A', value: 0 },
  { seq: 2, tMs: 12000, kind: 'event', event: 'cleared', actor: 'B', target: 'A', value: 0 },
  { seq: 3, tMs: 20000, kind: 'event', event: 'dp', actor: 'H', target: 'B', value: 12 },
  { seq: 4, tMs: 21000, kind: 'event', event: 'dp', actor: 'H', target: 'A', value: 25 },
  { seq: 5, tMs: 30000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
  { seq: 6, tMs: 31000, kind: 'chat', actor: 'A', team: 'survivor', text: 'nice' },
  { seq: 7, tMs: 40000, kind: 'event', event: 'ff', actor: 'A', target: 'B', value: 7 },
  { seq: 8, tMs: 41000, kind: 'event', event: 'ff', actor: 'A', target: 'B', value: 3 },
  { seq: 9, tMs: 50000, kind: 'event', event: 'incap', actor: 'B', target: 'H', value: 0 },
  { seq: 10, tMs: 60000, kind: 'event', event: 'death', actor: 'B', target: 'H', value: 0 },
];

const col = (side: 'survivor' | 'infected', key: string) => {
  const c = BOX_COLUMNS[side].find((x) => x.key === key);
  if (!c) throw new Error(`no column ${side}/${key}`);
  return c;
};

describe('boxScore', () => {
  it('tallies a player by role up to the playhead, ignoring later events and chat', () => {
    const a = boxScore(T, 35000, 'A', 'survivor');
    expect(a[col('survivor', 'skeet').key]).toBe(1);
    expect(a[col('survivor', 'pinned').key]).toBe(1);
    expect(a[col('survivor', 'ff').key]).toBe(0); // 40s and 41s are ahead
    const later = boxScore(T, 60000, 'A', 'survivor');
    expect(later[col('survivor', 'ff').key]).toBe(10); // FF sums damage, 7 + 3
  });

  it('counts the infected side from the same events, seen from the doer', () => {
    const h = boxScore(T, 60000, 'H', 'infected');
    expect(h[col('infected', 'pinned').key]).toBe(1);
    expect(h[col('infected', 'dp').key]).toBe(2);
    expect(h[col('infected', 'dp_dmg').key]).toBe(37);
    expect(h[col('infected', 'incap').key]).toBe(1);
    expect(h[col('infected', 'death').key]).toBe(1);
    expect(h[col('infected', 'skeet').key]).toBe(1); // got skeeted
  });

  it('exact playhead is inclusive, and a player in no events is all zeros', () => {
    expect(boxScore(T, 10000, 'A', 'survivor')[col('survivor', 'pinned').key]).toBe(1);
    const z = boxScore(T, 60000, 'Z', 'survivor');
    for (const c of BOX_COLUMNS.survivor) expect(z[c.key]).toBe(0);
  });

  it('keeps only columns whose kind occurs anywhere in the round, so columns never jump mid-play', () => {
    const surv = columnsPresent(T, 'survivor').map((c) => c.key);
    expect(surv).toContain('skeet');
    expect(surv).toContain('ff');
    expect(surv).not.toContain('tank_death');
    expect(surv).not.toContain('revive');
    const inf = columnsPresent(T, 'infected').map((c) => c.key);
    expect(inf).toContain('dp');
    expect(inf).not.toContain('boom');
  });
});
