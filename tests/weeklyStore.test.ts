import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { freezeWeek, frozenWeek, frozenWeeks, playerWeeklyAwards } from '../src/weeklyStore.js';
import { seedMatch, seedPlayers, seedReadyup } from './weeklyFixtures.js';

let db: DB; let P: string[];
beforeEach(() => { db = openDb(':memory:'); P = seedPlayers(db, 4); });
const W = '2026-09-21';
const W2 = '2026-09-28';
// The real clock in CI is 2026-09-27, so both weeks above are still open on
// it. Freeze against a fixed later date instead of relying on the real clock.
const NOW = new Date('2026-10-12T00:00:00Z');
// Hours start at 12 so every match lands after the Monday noon UTC week start.
function skeetWeek(week: string, p: string, n = 5) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(seedMatch(db, { endedAt: `${week} ${12 + i}:00:00`, lines: [{ id: p, team: 'a', stats: { skeets: 3 } }] }));
  return ids;
}

describe('weeklyStore', () => {
  it('freezes once and reads back the same awards and recap', () => {
    skeetWeek(W, P[0]);
    expect(freezeWeek(db, W, NOW)).toBe(true);
    expect(freezeWeek(db, W, NOW)).toBe(false);
    const f = frozenWeek(db, W)!;
    expect(f.awards.find((a) => a.key === 'skeets' && a.kind === 'avg')!.winners[0]).toMatchObject({ steamid: P[0], name: 'p0', value: 3, games: 5 });
    expect(f.recap.matches).toBe(5);
    expect(f.postedAt).toBeNull();
  });

  it('a void after freezing does not change the frozen week', () => {
    const ids = skeetWeek(W, P[0]);
    freezeWeek(db, W, NOW);
    db.prepare("UPDATE matches SET voided_at = '2026-09-29 00:00:00' WHERE id = ?").run(ids[0]);
    expect(frozenWeek(db, W)!.recap.matches).toBe(5);
  });

  it('a week with no matches still freezes, with no awards', () => {
    expect(freezeWeek(db, W, NOW)).toBe(true);
    expect(frozenWeek(db, W)).toMatchObject({ awards: [], recap: { matches: 0 } });
  });

  it('keeps the win rate detail', () => {
    for (let i = 0; i < 5; i++) seedMatch(db, { endedAt: `${W} ${12 + i}:00:00`, winner: i < 4 ? 'a' : 'b', lines: [{ id: P[0], team: 'a' }] });
    freezeWeek(db, W, NOW);
    expect(frozenWeek(db, W)!.awards.find((a) => a.key === 'win_rate')!.winners[0].detail).toBe('4-1');
  });

  it('player awards group by award, count weeks, and leave out shame awards', () => {
    const a = skeetWeek(W, P[0]);
    a.forEach((m) => seedReadyup(db, m, { [P[0]]: 60 }));
    skeetWeek(W2, P[0]);
    freezeWeek(db, W, NOW); freezeWeek(db, W2, NOW);
    expect(frozenWeeks(db)).toEqual([W2, W]);
    const mine = playerWeeklyAwards(db, P[0]);
    const skeets = mine.find((x) => x.award === 'skeets')!;
    expect(skeets).toEqual({ award: 'skeets', label: 'Skeets', count: 2, weeks: [W2, W] });   // avg and total in a week count once
    expect(mine.some((x) => x.award === 'slow_ready')).toBe(false);
    expect(mine[0].count).toBeGreaterThanOrEqual(mine[mine.length - 1].count);
  });

  it('rejects a week id that is not a Monday, even if it parses', () => {
    expect(() => freezeWeek(db, '2026-09-22', NOW)).toThrow('not a week start: 2026-09-22');
  });

  it('rejects a calendar-invalid week id without throwing from inside weekStartOf', () => {
    expect(() => freezeWeek(db, '2026-13-01', NOW)).toThrow('not a week start: 2026-13-01');
    expect(() => freezeWeek(db, '2026-01-32', NOW)).toThrow('not a week start: 2026-01-32');
  });

  it('refuses to freeze the week that is still open on the given clock', () => {
    // W2 (2026-09-28) has not closed yet as of NOW... use a NOW inside it.
    const stillOpen = new Date('2026-09-30T00:00:00Z');
    expect(() => freezeWeek(db, W2, stillOpen)).toThrow('week not closed yet: 2026-09-28');
  });

  it('freezes a week once it has actually closed, using the default now', () => {
    // No now argument: this exercises the real clock, so only use a week that
    // is closed on any real clock this suite will run under.
    expect(freezeWeek(db, '2020-01-06')).toBe(true);
  });
});
