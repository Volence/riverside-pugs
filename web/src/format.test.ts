import { describe, it, expect } from 'vitest';
import {
  campaignName, winnerLabel, fmtDate, fmtDelta, deltaClass, fmtClock,
  secondsLeft, sparklinePoints, fmtBytes, orderLiveStatKeys, orderStatKeysBySide, statGroupStarts, labelFor, liveGroupStarts, LIVE_STAT_ORDER,
  deriveLiveStats, fmtLatency,
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
    // skeets_hurt used to sit in this family; it is now a dead key, so the
    // contiguity that matters is skeets beside team_skeets and skeet_assists.
    const keys = orderLiveStatKeys(['ck', 'skeets', 'team_skeets', 'skeet_assists', 'boomer_spawns']);
    expect(keys).toEqual(['ck', 'skeets', 'team_skeets', 'skeet_assists', 'boomer_spawns']);
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

describe('orderStatKeysBySide', () => {
  const defs = [
    { key: 'skeets', side: 'survivor' as const },
    { key: 'crowns', side: 'survivor' as const },
    { key: 'draw_crowns', side: 'survivor' as const },
    { key: 'skeets_melee', side: 'survivor' as const },
    { key: 'skeets_sniper', side: 'survivor' as const },
    { key: 'deadstops', side: 'survivor' as const },
    { key: 'tongue_cuts', side: 'survivor' as const },
    { key: 'biles_landed', side: 'infected' as const },
    { key: 'survivors_biled', side: 'infected' as const },
    { key: 'damage_as_si', side: 'infected' as const },
  ];

  it('puts every survivor column before every infected column', () => {
    const out = orderStatKeysBySide(['biles_landed', 'skeets', 'damage_as_si', 'crowns'], defs);
    const lastSurvivor = Math.max(out.indexOf('skeets'), out.indexOf('crowns'));
    const firstInfected = Math.min(out.indexOf('biles_landed'), out.indexOf('damage_as_si'));
    expect(lastSurvivor).toBeLessThan(firstInfected);
  });

  it('keeps a stat beside its own side rather than in a shared alphabetical tail', () => {
    // draw_crowns used to sort into one alphabetical heap shared by both sides,
    // landing nowhere near crowns. Both are survivor keys, so both belong in the
    // survivor block, ahead of anything infected.
    const out = orderStatKeysBySide(['crowns', 'draw_crowns', 'biles_landed'], defs);
    expect(out.indexOf('draw_crowns')).toBeLessThan(out.indexOf('biles_landed'));
  });

  it('drops stats that cannot occur in L4D1 pug play', () => {
    const out = orderStatKeysBySide(
      ['skeets', 'skeets_melee', 'skeets_sniper', 'deadstops', 'tongue_cuts', 'survivors_biled'],
      defs,
    );
    expect(out).toEqual(['skeets']);
  });

  it('leads with core columns that the registry gives no side', () => {
    const out = orderStatKeysBySide(['skeets', 'ck', 'biles_landed'], defs);
    expect(out[0]).toBe('ck');
  });
});

describe('labelFor, for stats whose short label misleads', () => {
  it('does not call high pounces "DPs", which upper-cases into DPS', () => {
    expect(labelFor('dps_landed')).toBe('High pounces');
  });
});

describe('orderLiveStatKeys and the dead-key set', () => {
  it('drops L4D1-impossible stats from the live view too', () => {
    // survivors_biled really is present in match_live_players.stats_json, so
    // without this the live card carries a permanently-zero column.
    expect(orderLiveStatKeys(['skeets', 'survivors_biled'])).toEqual(['skeets']);
  });
});

describe('stat families within a side', () => {
  // The callbacks are annotated rather than using `as const`. With `as const`
  // the first map() fixes the element type at side: 'survivor', and concat
  // then rejects the infected half, because a variable annotation does not
  // flow backwards into map's inference. The values are unchanged.
  type Def = { key: string; side: 'survivor' | 'infected' };
  const defs: Def[] = [
    'skeets', 'team_skeets', 'skeet_assists', 'clears', 'insta_clears',
    'crowns', 'draw_crowns', 'tank_damage', 'rock_skeets', 'boomer_pops',
  ].map((key): Def => ({ key, side: 'survivor' })).concat(
    ['damage_as_si', 'dps_landed', 'pounce_damage_high', 'boomer_spawns',
      'boom_successes', 'boomed_vomit', 'biles_landed', 'tank_punches',
    ].map((key): Def => ({ key, side: 'infected' })),
  );

  const adjacent = (out: string[], a: string, b: string) =>
    Math.abs(out.indexOf(a) - out.indexOf(b)) === 1;

  it('puts crowns next to draw crowns', () => {
    const out = orderStatKeysBySide(['crowns', 'skeets', 'draw_crowns', 'clears'], defs);
    expect(adjacent(out, 'crowns', 'draw_crowns')).toBe(true);
  });

  it('puts tank damage next to rocks shot', () => {
    const out = orderStatKeysBySide(['tank_damage', 'skeets', 'rock_skeets'], defs);
    expect(adjacent(out, 'tank_damage', 'rock_skeets')).toBe(true);
  });

  it('keeps the boomer cluster contiguous', () => {
    const out = orderStatKeysBySide(
      ['boomer_spawns', 'tank_punches', 'boom_successes', 'damage_as_si', 'boomed_vomit'], defs,
    );
    const boomer = ['boomer_spawns', 'boom_successes', 'boomed_vomit'].map((k) => out.indexOf(k));
    expect(Math.max(...boomer) - Math.min(...boomer)).toBe(boomer.length - 1);
  });

  it('drops the two skeet columns that say nothing on L4D1', () => {
    // Shotgun is the only weapon class skill_detect can tag here, and a chip
    // skeet only means anything as a ratio.
    const out = orderStatKeysBySide(['skeets', 'skeets_shotgun', 'skeets_hurt'], defs);
    expect(out).toEqual(['skeets']);
  });
});

describe('statGroupStarts', () => {
  it('marks the first present column of each family, never the very first', () => {
    const starts = statGroupStarts(['ck', 'skeets', 'team_skeets', 'crowns']);
    expect(starts.has('ck')).toBe(false);
    expect(starts.has('skeets')).toBe(true);
    expect(starts.has('team_skeets')).toBe(false);
    expect(starts.has('crowns')).toBe(true);
  });
});

describe('fmtLatency', () => {
  it('reads in seconds to one decimal, which is the resolution that matters', () => {
    expect(fmtLatency(910)).toBe('0.9s');
    expect(fmtLatency(1800)).toBe('1.8s');
    expect(fmtLatency(0)).toBe('0.0s');
  });
});
