import { describe, it, expect } from 'vitest';
import {
  campaignName, winnerLabel, fmtDate, fmtDelta, deltaClass, fmtClock,
  secondsLeft, sparklinePoints, fmtBytes, orderLiveStatKeys, labelFor, liveGroupStarts, LIVE_STAT_ORDER,
  deriveLiveStats,
} from './format';

describe('campaignName', () => {
  it('maps known slugs and passes unknown ones through', () => {
    expect(campaignName('no_mercy')).toBe('No Mercy');
    expect(campaignName('blood_harvest')).toBe('Blood Harvest');
    expect(campaignName('crash_course')).toBe('crash_course');
  });
});

describe('winnerLabel', () => {
  it('names the team, or says Draw', () => {
    expect(winnerLabel('a')).toBe('Team A');
    expect(winnerLabel('b')).toBe('Team B');
    expect(winnerLabel('draw')).toBe('Draw');
  });
});

describe('fmtDate', () => {
  it('trims an ISO timestamp to minutes', () => {
    expect(fmtDate('2026-09-06T04:12:33.000Z')).toBe('2026-09-06 04:12');
  });
  it('returns empty for null/undefined rather than "Invalid Date"', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
  });
});

describe('fmtDelta', () => {
  it('always prints a sign, with a real minus for negatives', () => {
    expect(fmtDelta(12)).toBe('+12');
    expect(fmtDelta(-9)).toBe('−9');
    expect(fmtDelta(0)).toBe('±0');
  });

  it('uses U+2212, not a hyphen, so delta columns align', () => {
    expect(fmtDelta(-9).charCodeAt(0)).toBe(0x2212);
    expect(fmtDelta(-9)).not.toContain('-');
  });

  it('classes a delta by direction', () => {
    expect(deltaClass(1)).toContain('delta--up');
    expect(deltaClass(-1)).toContain('delta--down');
    expect(deltaClass(0)).toBe('delta');
  });
});

describe('fmtClock', () => {
  it('formats mm:ss with a padded seconds field', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(9)).toBe('0:09');
    expect(fmtClock(75)).toBe('1:15');
  });
  it('floors fractions and never goes negative', () => {
    expect(fmtClock(9.9)).toBe('0:09');
    expect(fmtClock(-5)).toBe('0:00');
  });
});

describe('secondsLeft', () => {
  it('counts down to a deadline and clamps at zero', () => {
    const now = 1_000_000;
    expect(secondsLeft(now + 30_000, now)).toBe(30);
    expect(secondsLeft(now - 5_000, now)).toBe(0);
  });
});

describe('sparklinePoints', () => {
  it('returns null below two points, because a dot implies a trend it cannot support', () => {
    expect(sparklinePoints([], 100, 50)).toBeNull();
    expect(sparklinePoints([1200], 100, 50)).toBeNull();
  });

  it('spans the full width and inverts y so higher SR sits higher', () => {
    const pts = sparklinePoints([0, 100], 100, 50, 5)!.split(' ');
    expect(pts).toHaveLength(2);
    const [x0, y0] = pts[0].split(',').map(Number);
    const [x1, y1] = pts[1].split(',').map(Number);
    expect(x0).toBe(0);
    expect(x1).toBe(100);
    expect(y0).toBe(45); // the low value sits at the bottom, inside the pad
    expect(y1).toBe(5);  // the high value at the top
    expect(y1).toBeLessThan(y0);
  });

  it('draws a flat series as a centered line instead of dividing by zero', () => {
    const pts = sparklinePoints([1200, 1200, 1200], 100, 50)!;
    expect(pts).not.toContain('NaN');
    for (const p of pts.split(' ')) expect(Number(p.split(',')[1])).toBe(25);
  });
});

describe('fmtBytes', () => {
  it('scales the unit across the range a demo can span', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('returns empty for nonsense rather than NaN', () => {
    expect(fmtBytes(NaN)).toBe('');
    expect(fmtBytes(-1)).toBe('');
  });
});

describe('orderLiveStatKeys', () => {
  it('puts known keys in display order and appends unknown ones alphabetically', () => {
    expect(orderLiveStatKeys(['zzz_new', 'skeets', 'ck', 'aaa_new', 'hp']))
      .toEqual(['hp', 'ck', 'skeets', 'aaa_new', 'zzz_new']);
  });

  it('omits known keys that are not present', () => {
    expect(orderLiveStatKeys(['ck'])).toEqual(['ck']);
  });

  it('labels the live-only keys', () => {
    expect(labelFor('ck')).toBe('Commons');
    expect(labelFor('hp')).toBe('HP');
    expect(labelFor('tank_damage')).toBe('Tank damage');
  });
});

describe('liveGroupStarts', () => {
  it('marks the first present column of each group, never the leading column', () => {
    const keys = orderLiveStatKeys(['hp', 'ck', 'tank_damage', 'skeets']);
    const starts = liveGroupStarts(keys);
    expect(starts.has('hp')).toBe(false);   // leading column gets no divider
    expect(starts.has('tank_damage')).toBe(true);
    expect(starts.has('skeets')).toBe(true);
    expect(starts.has('ck')).toBe(false);
  });

  it('falls through to the next present key when a group leader is missing', () => {
    const keys = orderLiveStatKeys(['ck', 'tank_punches', 'boomer_pops']);
    const starts = liveGroupStarts(keys);
    expect(starts.has('tank_punches')).toBe(true);
    expect(starts.has('boomer_pops')).toBe(true);
  });

  it('no longer offers deadstops or tongue cuts as live columns', () => {
    expect(LIVE_STAT_ORDER).not.toContain('deadstops');
    expect(LIVE_STAT_ORDER).not.toContain('tongue_cuts');
    expect(LIVE_STAT_ORDER).toContain('tank_rocks_landed');
    expect(LIVE_STAT_ORDER).toContain('rock_skeets');
  });
});

describe('live columns: skeet variants and biles', () => {
  it('includes the chipped and team skeet variants', () => {
    expect(LIVE_STAT_ORDER).toContain('team_skeets');
    expect(LIVE_STAT_ORDER).toContain('skeets_hurt');
    expect(LIVE_STAT_ORDER).toContain('skeet_assists');
  });

  it('uses the l4dcompstats boom counters rather than the skill_detect bile ones', () => {
    // The console prints successes/attempts (N Vomit/M Proxy); the live table
    // shows the same four numbers so they can never disagree.
    expect(LIVE_STAT_ORDER).toContain('boomer_spawns');
    expect(LIVE_STAT_ORDER).toContain('boom_successes');
    expect(LIVE_STAT_ORDER).toContain('boomed_vomit');
    expect(LIVE_STAT_ORDER).toContain('boomed_proxy');
  });

  it('keeps the skeet family contiguous and gives it its own divider', () => {
    const keys = orderLiveStatKeys(['ck', 'skeets', 'team_skeets', 'skeets_hurt', 'boomer_spawns']);
    expect(keys).toEqual(['ck', 'skeets', 'team_skeets', 'skeets_hurt', 'boomer_spawns']);
    const starts = liveGroupStarts(keys);
    expect(starts.has('skeets')).toBe(true);
    expect(starts.has('team_skeets')).toBe(false);
    expect(starts.has('boomer_spawns')).toBe(true);
  });

  it('drops the summed pounce damage column in favour of the event feed', () => {
    expect(LIVE_STAT_ORDER).not.toContain('pounce_damage_high');
  });
});

describe('deriveLiveStats', () => {
  it('computes boomer success rate from biles over spawns', () => {
    expect(deriveLiveStats({ boomer_spawns: 4, boom_successes: 3 }).boomer_rate).toBe(75);
    expect(deriveLiveStats({ boomer_spawns: 3, boom_successes: 1 }).boomer_rate).toBe(33);
  });

  it('omits the rate entirely when nobody has played boomer', () => {
    // Absent, not 0: "has not played boomer" is a different fact from
    // "played boomer and landed nothing", and the table renders absent as n/a.
    expect(deriveLiveStats({ boom_successes: 0 }).boomer_rate).toBeUndefined();
    expect(deriveLiveStats({ boomer_spawns: 0, boom_successes: 0 }).boomer_rate).toBeUndefined();
  });

  it('reports 0% for a boomer who landed nothing', () => {
    expect(deriveLiveStats({ boomer_spawns: 2, boom_successes: 0 }).boomer_rate).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = { boomer_spawns: 2, boom_successes: 1 };
    deriveLiveStats(input);
    expect(input).toEqual({ boomer_spawns: 2, boom_successes: 1 });
  });
});
