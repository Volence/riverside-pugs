import { describe, it, expect } from 'vitest';
import { formatAwardValue, renderAwards, renderRecap } from '../src/discord/weeklyCard.js';
import type { FrozenWeek } from '../src/weeklyStore.js';
import type { Recap } from '../src/weeklyRecap.js';

const w = (steamid: string, name: string, value: number, detail: string | null = null) => ({ steamid, name, value, games: 5, detail });
const emptyRecap: Recap = {
  matches: 0, players: 0, peakConcurrent: 0, busiestDay: null, highlights: [], mostQuads: null,
  totals: [], streaks: [], iron: [], closest: null,
};
const week = (over: Partial<FrozenWeek> = {}): FrozenWeek => ({
  week: '2026-09-21', frozenAt: '2026-09-28 00:05:00', postedAt: null, recap: emptyRecap, awards: [], ...over,
});
const EMOJI = /\p{Extended_Pictographic}/u;

describe('formatAwardValue', () => {
  it('formats each kind', () => {
    expect(formatAwardValue('tank_damage', 'avg', w('1', 'a', 8805.9))).toBe('8,806/g');
    expect(formatAwardValue('skeets', 'avg', w('1', 'a', 4.62))).toBe('4.6/g');
    expect(formatAwardValue('skeets', 'total', w('1', 'a', 1870))).toBe('1,870 total');
    expect(formatAwardValue('sr_climb', 'single', w('1', 'a', 767))).toBe('+767 SR');
    expect(formatAwardValue('win_rate', 'single', w('1', 'a', 0.79, '15-4'))).toBe('15-4');
    expect(formatAwardValue('slow_ready', 'single', w('1', 'a', 53.8))).toBe('54s per ready-up');
  });
});

describe('renderAwards', () => {
  it('collapses a double winner, joins ties, escapes names, has no emoji', () => {
    const f = week({ awards: [
      { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'avg', winners: [w('1', 'VII', 4.6)] },
      { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'total', winners: [w('1', 'VII', 187)] },
      { key: 'crowns', label: 'Witch crowns', group: 'survivor', kind: 'total', winners: [w('2', '**b**', 8), w('3', '@everyone', 8)] },
      { key: 'slow_ready', label: 'Slowest ready-up', group: 'shame', kind: 'single', winners: [w('4', 'slow', 53.8)] },
    ] });
    const p = renderAwards(f, 'https://pug.test')!;
    const text = p.embeds[0].description!;
    expect(text).toContain('**Skeets**: VII (4.6/g, 187 total)');
    expect(text).toContain('**Witch crowns**: \\*\\*b\\*\\* & \\@everyone 8 total');
    expect(text).toContain('**Shame**');
    expect(text).toContain('https://pug.test/leaderboard?week=2026-09-21');
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(EMOJI.test(JSON.stringify(p))).toBe(false);
    expect(p.mentionUserIds).toEqual([]);
  });

  it('returns null for a week with no awards', () => {
    expect(renderAwards(week(), 'https://pug.test')).toBeNull();
  });
});

describe('renderRecap', () => {
  it('writes the headline and sections like the Friday recap, under 2000 characters', () => {
    const recap: Recap = {
      ...emptyRecap, matches: 167, players: 138, peakConcurrent: 4, busiestDay: { date: '2026-09-26', matches: 36 },
      highlights: [{ key: 'skeets', verb: 'landed', label: 'skeets', player: { steamid: '1', name: 'epx' }, value: 12, matchId: 224 }],
      mostQuads: { matchId: 218, quads: 3 },
      totals: [{ key: 'skeets', label: 'skeets', value: 2822, leader: { steamid: '1', name: 'VII', value: 187 } }],
      streaks: [{ steamid: '5', name: 'mado', w: 15, l: 4 }],
      iron: [{ steamid: '6', name: 'shove', games: 57 }, { steamid: '7', name: 'adam', games: 51 }],
      closest: { matchId: 154, campaign: 'Death Toll', a: 177, b: 178 },
    };
    const c = renderRecap(week({ recap }), 'https://pug.test').content!;
    expect(c).toContain('**Weekly recap, week of Sep 21**');
    expect(c).toContain('**167 matches**');
    expect(c).toContain('**138 different players**');
    expect(c).toContain('**epx** landed **12 skeets** in one game (match 224)');
    expect(c).toContain('Match 218 had **3 quad caps**');
    expect(c).toContain('**mado** went **15-4**');
    expect(c).toContain('**shove** played **57 games**, with **adam** close behind at 51');
    expect(c).toContain('**Closest game:** match 154 on Death Toll, **178 to 177**');
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(EMOJI.test(c)).toBe(false);
  });

  it('a week with no matches says so briefly', () => {
    expect(renderRecap(week(), 'https://pug.test').content).toBe('**Weekly recap, week of Sep 21**\n\nNo matches were played this week.');
  });

  it('drops highlights from the end until it fits in 2000 characters', () => {
    const long = 'x'.repeat(30);
    const highlights = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, verb: 'landed', label: 'skeets', player: { steamid: String(i), name: long }, value: 9, matchId: i }));
    const c = renderRecap(week({ recap: { ...emptyRecap, matches: 1, players: 1, highlights } }), 'https://pug.test').content!;
    expect(c.length).toBeLessThanOrEqual(2000);
  });
});
