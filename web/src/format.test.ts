import { describe, it, expect } from 'vitest';
import {
  campaignName, winnerLabel, fmtDate, fmtDelta, deltaClass, fmtClock,
  secondsLeft, sparklinePoints, fmtBytes, orderLiveStatKeys, orderStatKeysBySide, statGroupStarts, labelFor, liveGroupStarts, LIVE_STAT_ORDER,
  deriveLiveStats, fmtLatency, mapName, survivalLabel, survivalNote, sortMapRows, MIN_SURVIVAL_SAMPLE, DEAD_STAT_KEYS,
  FEATURED_STAT_KEYS, statLeaders,
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

import { campaignTint } from './format';

describe('campaignTint', () => {
  it('returns the hand-picked token for the four L4D1 campaigns, with a hashed fallback', () => {
    expect(campaignTint('no_mercy')).toMatch(/^var\(--c-no-mercy, oklch\(/);
    expect(campaignTint('death_toll')).toMatch(/^var\(--c-death-toll, oklch\(/);
    expect(campaignTint('dead_air')).toMatch(/^var\(--c-dead-air, oklch\(/);
    expect(campaignTint('blood_harvest')).toMatch(/^var\(--c-blood-harvest, oklch\(/);
  });

  it('gives an unknown campaign a stable oklch tint at the shared weight', () => {
    const a = campaignTint('crash_course');
    expect(a).toBe(campaignTint('crash_course'));
    expect(a).toMatch(/^oklch\(0\.42 0\.06 \d+(\.\d+)?\)$/);
  });

  it('spreads different unknown campaigns across different hues', () => {
    const hues = new Set(['crash_course', 'the_passing', 'suicide_blitz', 'dead_before_dawn']
      .map((s) => campaignTint(s).match(/ (\d+(\.\d+)?)\)$/)![1]));
    expect(hues.size).toBe(4);
  });

  it('treats prototype keys as unknown campaigns', () => {
    for (const slug of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(campaignTint(slug)).toMatch(/^oklch\(/);
    }
  });
});

describe('mapName', () => {
  it('names the stock L4D1 chapters', () => {
    expect(mapName('l4d_vs_airport01_greenhouse')).toBe('The Greenhouse');
    expect(mapName('l4d_vs_farm04_barn')).toBe('The Train Station');
    expect(mapName('l4d_vs_hospital01_apartment')).toBe('The Apartments');
    expect(mapName('l4d_vs_smalltown05_houseboat')).toBe('Boathouse Finale');
  });

  it('treats the coop and versus variants of a chapter as the same map', () => {
    expect(mapName('l4d_farm01_hilltop')).toBe(mapName('l4d_vs_farm01_hilltop'));
  });

  it('names The Passing chapters, which carry no l4d_ prefix', () => {
    expect(mapName('c6m1_riverbank')).toBe('The Riverbank');
    expect(mapName('c6m2_bedlam')).toBe('Underground');
  });

  it('derives a readable name for a custom map it has never seen', () => {
    expect(mapName('l4d_vs_dam03_spillway')).toBe('Spillway');
    expect(mapName('l4d_vs_ravenholm02_mine_shaft')).toBe('Mine Shaft');
  });

  it('does not eat a custom name that has no campaign-and-chapter prefix', () => {
    expect(mapName('l4d_deadbeforedawn')).toBe('Deadbeforedawn');
  });

  it('is case insensitive and survives an empty name', () => {
    expect(mapName('L4D_VS_AIRPORT01_GREENHOUSE')).toBe('The Greenhouse');
    expect(mapName('')).toBe('');
  });
});

describe('survivalLabel', () => {
  it('says n/a when nothing was measured', () => {
    expect(survivalLabel(null, 0).value).toBe('n/a');
    expect(survivalLabel(null, 0).thin).toBe(true);
    // A percentage with a zero sample is contradictory; n/a wins.
    expect(survivalLabel(100, 0).value).toBe('n/a');
  });

  it('reports the count, not a rate, below the minimum sample', () => {
    const s = survivalLabel(100, 2);
    expect(s.value).toBe('2 rounds');
    expect(s.thin).toBe(true);
    expect(s.value).not.toContain('%');
    expect(survivalLabel(100, 1).value).toBe('1 round');
  });

  it('states the rate with its sample size once there is enough', () => {
    const s = survivalLabel(75, MIN_SURVIVAL_SAMPLE);
    expect(s.value).toBe('75%');
    expect(s.sub).toBe(`of ${MIN_SURVIVAL_SAMPLE} measured`);
    expect(s.thin).toBe(false);
  });
});

describe('DEAD_STAT_KEYS', () => {
  it('hides both halves of the deadstop pair, which L4D1 cannot produce', () => {
    // Written by one skill_detect forward, so one being dead means both are.
    expect(DEAD_STAT_KEYS.has('deadstops')).toBe(true);
    expect(DEAD_STAT_KEYS.has('times_deadstopped')).toBe(true);
  });

  it('keeps the private stat that does work', () => {
    expect(DEAD_STAT_KEYS.has('times_skeeted')).toBe(false);
  });
});

describe('FEATURED_STAT_KEYS', () => {
  it('features no stat that L4D1 cannot produce', () => {
    // A dead key here is not an error anywhere, it is a card that reads zero
    // forever, so the check has to live in a test.
    for (const k of FEATURED_STAT_KEYS) {
      expect(DEAD_STAT_KEYS.has(k), `${k} is a dead stat and would render an empty card`).toBe(false);
    }
  });

  it('features only stats the table has a label for', () => {
    for (const k of FEATURED_STAT_KEYS) expect(labelFor(k)).not.toBe(k);
  });

  it('features no self-visibility stat, which must never be ranked', () => {
    for (const k of ['times_skeeted', 'times_deadstopped']) {
      expect(FEATURED_STAT_KEYS.includes(k)).toBe(false);
    }
  });
});

describe('statLeaders', () => {
  const rows: { steamid: string; name: string; stats?: Record<string, number> }[] = [
    { steamid: '1', name: 'alice', stats: { skeets: 10, crowns: 0 } },
    { steamid: '2', name: 'bob', stats: { skeets: 25, crowns: 3 } },
    { steamid: '3', name: 'carol', stats: { skeets: 25 } },
    { steamid: '4', name: 'dave' },
  ];

  it('ranks by value, highest first', () => {
    expect(statLeaders(rows, 'skeets').map((r) => r.name)).toEqual(['bob', 'carol', 'alice']);
  });

  it('breaks a tie by name so the order is stable across renders', () => {
    const [a, b] = statLeaders(rows, 'skeets');
    expect(a.value).toBe(b.value);
    expect(a.name).toBe('bob');
    expect(b.name).toBe('carol');
  });

  it('excludes zero and missing values rather than padding the podium', () => {
    // alice has crowns: 0 and dave has no bag at all. Neither is third best.
    expect(statLeaders(rows, 'crowns').map((r) => r.name)).toEqual(['bob']);
    expect(statLeaders(rows, 'skeets').some((r) => r.name === 'dave')).toBe(false);
  });

  it('returns nothing for a stat nobody has scored', () => {
    expect(statLeaders(rows, 'tank_damage')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(statLeaders(rows, 'skeets', 2).map((r) => r.name)).toEqual(['bob', 'carol']);
  });
});

describe('survivalNote', () => {
  it('carries its own denominator, which is not the one beside it', () => {
    // 4 halves as survivor, 2 survived. The W/L count next to this is over
    // MAPS, a different and larger number, so the count has to travel.
    expect(survivalNote({ survivalMeasured: 4, survived: 2 })).toContain('50% survived of 4');
  });

  it('says nothing at all when no half was measured', () => {
    expect(survivalNote({ survivalMeasured: 0, survived: 0 })).toBe('');
    expect(survivalNote({})).toBe('');
  });

  it('reports a clean wipe record as 0%, not as nothing', () => {
    expect(survivalNote({ survivalMeasured: 3, survived: 0 })).toContain('0% survived of 3');
  });
});

describe('sortMapRows', () => {
  const row = (map: string, o: Partial<{ wins: number; losses: number; games: number; survivalMeasured: number; survived: number }> = {}) =>
    ({ map, wins: 0, losses: 0, games: 1, survivalMeasured: 0, survived: 0, ...o });

  it('puts your worst win rate first', () => {
    const rows = [row('good', { wins: 9, losses: 1 }), row('bad', { wins: 1, losses: 9 })];
    expect(sortMapRows(rows, 'winrate').map((r) => r.map)).toEqual(['bad', 'good']);
  });

  it('sorts by survival when asked, which can be a different order entirely', () => {
    // Wins well, dies constantly. The two measures answer different questions,
    // so the same list reorders.
    const rows = [
      row('winsButDies', { wins: 9, losses: 1, survivalMeasured: 10, survived: 1 }),
      row('losesButLives', { wins: 1, losses: 9, survivalMeasured: 10, survived: 9 }),
    ];
    expect(sortMapRows(rows, 'winrate').map((r) => r.map)).toEqual(['losesButLives', 'winsButDies']);
    expect(sortMapRows(rows, 'survival').map((r) => r.map)).toEqual(['winsButDies', 'losesButLives']);
  });

  it('sorts a row the measure says nothing about to the end, not to the front', () => {
    const rows = [row('nodata'), row('bad', { wins: 1, losses: 9 })];
    expect(sortMapRows(rows, 'winrate').map((r) => r.map)).toEqual(['bad', 'nodata']);
    expect(sortMapRows(rows, 'survival').map((r) => r.map)[1]).toBe('nodata');
  });

  it('does not mutate the array it was given', () => {
    const rows = [row('b', { wins: 9, losses: 1 }), row('a', { wins: 1, losses: 9 })];
    sortMapRows(rows, 'winrate');
    expect(rows.map((r) => r.map)).toEqual(['b', 'a']);
  });
});
