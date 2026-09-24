import { describe, it, expect } from 'vitest';
import { percentile, aggregate, calibrate, occupancyZ, scorePlayers, type PlayerAgg } from '../src/integrity/score.js';
import { TUNING } from '../src/integrity/constants.js';
import type { OccResult } from '../src/integrity/occupancy.js';
import type { RoundMetrics } from '../src/integrity/round.js';
import type { HiddenMetrics } from '../src/integrity/hidden.js';

const m = (over: Partial<RoundMetrics> = {}): RoundMetrics => ({
  fidMax: 0.2, fidP95: 0.1, windows: 12, scoreable: 10, fidSum: 0.1, occ: null, eligiblePairs: 100,
  gates: { considered: 400, notLive: 20, notGhost: 100, inGrace: 50, tooClose: 30, occluded: 100, passed: 100 },
  ...over,
});

describe('percentile', () => {
  it('is 0 for the lowest value and 1 for the highest', () => {
    expect(percentile([1, 2, 3], 1)).toBe(0);
    expect(percentile([1, 2, 3], 3)).toBe(1);
  });

  it('is the fraction STRICTLY below the value, over n-1 rather than n', () => {
    // Two of the four are below 3, and the denominator is 3, so 2/3. Over n it
    // would be 1/2. The description used to say "at or below", which would be
    // 3/4 and is not what any of these assertions show.
    expect(percentile([1, 2, 3, 4], 3)).toBeCloseTo(2 / 3);
  });

  it('returns exactly 1 for the top of the population, by construction', () => {
    // Why the admin board renders a rank and not this number: the leader always
    // reads 100%, whatever they actually measured.
    expect(percentile([0.1, 0.2, 0.62], 0.62)).toBe(1);
  });

  it('is 0 for an empty or single-member population rather than NaN', () => {
    expect(percentile([], 5)).toBe(0);
    expect(percentile([5], 5)).toBe(0);
  });
});

/** `blocks` blocks, each with prior `p`, of which the player was on the ghost
 *  for `observed` blocks' worth. */
const occ = (observed: number, blocks = 100, p = 0.1): OccResult =>
  ({ observed, expected: blocks * p, expectedSq: blocks * p * p, blocks, pairs: blocks * 50 });

describe('occupancyZ', () => {
  it('is the excess over expectation in binomial standard deviations', () => {
    // 100 blocks at 0.1: expect 10, sd 3. Sixteen observed is two sd over.
    expect(occupancyZ(occ(16), 1)).toBeCloseTo(2, 10);
    expect(occupancyZ(occ(10), 1)).toBeCloseTo(0, 10);
  });

  it('scales the prior by the calibration before comparing', () => {
    // The prior says 10 but players on this map really manage half that. Five
    // observed is then exactly what was expected.
    expect(occupancyZ(occ(5), 0.5)).toBeCloseTo(0, 10);
    expect(occupancyZ(occ(10), 0.5)!).toBeGreaterThan(2);
  });

  it('is null rather than a division by nothing', () => {
    expect(occupancyZ({ observed: 1, expected: 1, expectedSq: 1, blocks: 1, pairs: 10 }, 1)).toBeNull();
    expect(occupancyZ(occ(0, 0), 1)).toBeNull();
  });
});

/**
 * Why there is a calibration at all. The aim prior is not a probability that
 * "this player is within E_DWELL of that ghost": it is how often ANY survivor's
 * wedge touched the ghost's 256 unit cell, from anywhere, walls ignored, and the
 * frames it is compared against have already lost every moment something
 * visible stood near the ghost's bearing, which is exactly when people look
 * that way. Over the real history players were on a ghost 0.47 times as often
 * as the prior said, and by map that ran from 0.20 to 0.97. Against the raw
 * prior the typical honest player-round scored -0.6 and a player's pooled
 * history -3.9. So what the prior is asked for is its SHAPE, and the level is
 * taken from what the players on the board actually did on that map.
 */
describe('calibrate', () => {
  it('is observed over expected, per map', () => {
    const cal = calibrate([
      { steamid: 'a', map: 'm1', metrics: m({ occ: occ(5, 100) }) },
      { steamid: 'b', map: 'm1', metrics: m({ occ: occ(7, 100) }) },
      { steamid: 'a', map: 'm2', metrics: m({ occ: occ(18, 200) }) },
    ]);
    expect(cal('m1')).toBeCloseTo(12 / 20, 10);
    expect(cal('m2')).toBeCloseTo(18 / 20, 10);
  });

  it('falls back to the whole board for a map with too little on it to calibrate, or no map', () => {
    const cal = calibrate([
      { steamid: 'a', map: 'big', metrics: m({ occ: occ(10, 200) }) },
      { steamid: 'a', map: 'thin', metrics: m({ occ: occ(3, 10) }) },
      { steamid: 'a', map: null, metrics: m({ occ: occ(1, 10) }) },
    ]);
    const all = (10 + 3 + 1) / (20 + 1 + 1);
    expect(cal('thin')).toBeCloseTo(all, 10);
    expect(cal(null)).toBeCloseTo(all, 10);
    expect(cal('never seen')).toBeCloseTo(all, 10);
  });

  it('is 1, the prior taken at its word, when nothing has been measured', () => {
    expect(calibrate([{ steamid: 'a', map: 'm', metrics: m() }])('m')).toBe(1);
  });
});

describe('aggregate', () => {
  it('keeps a player HIGHEST window as context and takes their mean for fidP95', () => {
    const got = aggregate([
      { steamid: 'a', metrics: m({ fidMax: 0.4, fidP95: 0.2 }) },
      { steamid: 'a', metrics: m({ fidMax: 0.9, fidP95: 0.4 }) },
    ]);
    expect(got[0].rounds).toBe(2);
    expect(got[0].fidMax).toBeCloseTo(0.9);
    expect(got[0].fidP95).toBeCloseTo(0.3);
  });

  // fidMax was the board's tracking key, and a maximum over rounds can only go
  // up: on the live board it averaged 0.00 for players with 8 to 15 rounds and
  // 0.25 for players with 64 or more. That ranks playtime.
  it('measures tracking as a share of the windows that could be scored, pooled over every round', () => {
    const got = aggregate([
      { steamid: 'a', metrics: m({ scoreable: 30, fidSum: 3 }) },
      { steamid: 'a', metrics: m({ scoreable: 10, fidSum: 0 }) },
    ]);
    // 3 over 40, not the mean of 0.1 and 0: a round with more chances in it
    // weighs more.
    expect(got[0].trackShare).toBeCloseTo(3 / 40, 10);
    expect(got[0].scoreable).toBe(40);
  });

  it('does not grow with playtime: the same one lucky window is worth less the more chances there were', () => {
    const lucky = m({ fidMax: 0.6, scoreable: 10, fidSum: 0.6 });
    const clean = m({ fidMax: 0, scoreable: 10, fidSum: 0 });
    const few = aggregate([lucky, clean, clean].map((metrics) => ({ steamid: 'few', metrics })))[0];
    const many = aggregate([lucky, ...Array.from({ length: 59 }, () => clean)].map((metrics) => ({ steamid: 'many', metrics })))[0];
    expect(many.fidMax).toBe(few.fidMax);
    expect(many.trackShare!).toBeLessThan(few.trackShare!);
  });

  it('has no tracking share at all under MIN_TRACK_WINDOWS, because a ratio of two or three runs is noise', () => {
    const got = aggregate([{ steamid: 'a', metrics: m({ scoreable: TUNING.MIN_TRACK_WINDOWS - 1, fidSum: 5 }) }]);
    expect(got[0].trackShare).toBeNull();
  });

  it('counts a round as eligible only when the detector had a chance in it', () => {
    const got = aggregate([
      { steamid: 'a', metrics: m() },
      { steamid: 'a', metrics: m({ eligiblePairs: 0 }) },
    ]);
    expect(got[0].rounds).toBe(2);
    expect(got[0].eligibleRounds).toBe(1);
  });

  it('leaves occZ null for a player whose rounds were all on unscored maps', () => {
    expect(aggregate([{ steamid: 'a', metrics: m() }])[0].occZ).toBeNull();
  });

  it('centres occupancy on what the board actually does, so an ordinary player reads about zero', () => {
    // Everyone manages half of what the prior predicts. Nobody stands out.
    const rows = ['a', 'b', 'c', 'd'].map((steamid) => ({ steamid, map: 'm', metrics: m({ occ: occ(5) }) }));
    for (const p of aggregate(rows)) expect(p.occZ).toBeCloseTo(0, 10);
  });

  it('shows the one player who is on ghosts far more than the rest of the board', () => {
    const rows = [
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((steamid) => ({ steamid, map: 'm', metrics: m({ occ: occ(5) }) })),
      { steamid: 'sus', map: 'm', metrics: m({ occ: occ(25) }) },
    ];
    const got = aggregate(rows);
    expect(got.find((p) => p.steamid === 'sus')!.occZ!).toBeGreaterThan(5);
    expect(got.find((p) => p.steamid === 'a')!.occZ!).toBeLessThan(0);
  });

  // Metric C. It used to be worked out when the round was analysed, from the
  // uncalibrated number, where a player with more eligible time was pushed
  // further negative than a teammate with less for no reason but exposure.
  it('takes the team gap from the calibrated scores of the same round', () => {
    const rows = [
      { steamid: 'a', map: 'm', round: '1/1/1', metrics: m({ occ: occ(14) }) },
      { steamid: 'b', map: 'm', round: '1/1/1', metrics: m({ occ: occ(2) }) },
      { steamid: 'c', map: 'm', round: '1/1/1', metrics: m({ occ: occ(2) }) },
      // Another round entirely: not a's teammate.
      { steamid: 'd', map: 'm', round: '1/2/1', metrics: m({ occ: occ(2) }) },
    ];
    const got = aggregate(rows);
    const k = 20 / 40;
    const gap = occupancyZ(occ(14), k)! - occupancyZ(occ(2), k)!;
    expect(got.find((p) => p.steamid === 'a')!.teamGap).toBeCloseTo(gap, 10);
    expect(got.find((p) => p.steamid === 'd')!.teamGap).toBeNull();
  });
});

const agg = (steamid: string, over: Partial<PlayerAgg> = {}): PlayerAgg => ({
  steamid, rounds: 20, eligibleRounds: 20, fidMax: 0, fidP95: 0, scoreable: 100,
  trackShare: 0, occZ: 0, teamGap: 0,
  losRounds: 0, hiddenScoreable: 0, hiddenShare: null, hiddenOccZ: null, reveals: 0, revealShare: null,
  byClass: {
    hunter: { hiddenShare: null, hiddenOccZ: null, revealShare: null },
    smoker: { hiddenShare: null, hiddenOccZ: null, revealShare: null },
    boomer: { hiddenShare: null, hiddenOccZ: null, revealShare: null },
  },
  ...over,
});

describe('scorePlayers', () => {
  // CHANGED 2026-09-21. This previously asserted a composite of 1.0: only the
  // metrics a player actually had were averaged. That is a defensible reading
  // (an unmeasured metric is not evidence either way) but on the live board it
  // put a 3-round player with two n/a at rank 1 of 82, ranked on one number,
  // above players with a hundred rounds measured on all three. Since the
  // composite exists to order WHO IS WORTH WATCHING, ranking someone top for
  // having almost no data wastes exactly the reviewer time it is meant to save.
  // A missing metric now counts as the middle of the population.
  it('reports a missing metric as null but counts it as neutral in the composite', () => {
    const [a] = scorePlayers([
      agg('a', { trackShare: 0.3, occZ: null, teamGap: null }),
      agg('b', { trackShare: 0.01, occZ: null, teamGap: null }),
    ]);
    expect(a.pOcc).toBeNull();
    expect(a.composite).toBeCloseTo((1 + 0.5 + 0.5) / 3, 5);
  });

  it('ranks the tracking player above the rest', () => {
    const got = scorePlayers([
      agg('clean1', { trackShare: 0.002, occZ: 0.1, teamGap: 0 }),
      agg('clean2', { trackShare: 0.004, occZ: -0.2, teamGap: -0.1 }),
      agg('sus', { trackShare: 0.31, occZ: 1.9, teamGap: 1.7 }),
    ]);
    expect(got[0].steamid).toBe('sus');
    expect(got[0].composite!).toBeGreaterThan(got[1].composite!);
  });

  it('ranks on the tracking share and not on the best window', () => {
    const got = scorePlayers([
      agg('veteran', { fidMax: 0.6, trackShare: 0.004, rounds: 120, eligibleRounds: 120 }),
      agg('newer', { fidMax: 0.3, trackShare: 0.09 }),
    ]);
    expect(got.find((p) => p.steamid === 'newer')!.pFid).toBe(1);
    expect(got.find((p) => p.steamid === 'veteran')!.pFid).toBe(0);
  });
});

describe('the minimum rounds gate', () => {
  it('does not rank a player with too few eligible rounds, whatever their one round said', () => {
    const got = scorePlayers([
      agg('one-round', { rounds: 1, eligibleRounds: 1, trackShare: 0.9, occZ: 6, teamGap: 6 }),
      agg('a', { trackShare: 0.01, occZ: 0.5, teamGap: 0.2 }),
      agg('b', { trackShare: 0.02, occZ: -0.5, teamGap: -0.2 }),
    ]);
    const last = got[got.length - 1];
    expect(last.steamid).toBe('one-round');
    expect(last.ranked).toBe(false);
    expect(last.composite).toBeNull();
    expect(last.pFid).toBeNull();
  });

  it('keeps them out of the population everyone else is ranked within', () => {
    const got = scorePlayers([
      agg('one-round', { rounds: 1, eligibleRounds: 1, trackShare: 0.9 }),
      agg('a', { trackShare: 0.02 }),
      agg('b', { trackShare: 0.01 }),
    ]);
    // Top of the RANKED population, which the one-round player is not part of.
    expect(got.find((p) => p.steamid === 'a')!.pFid).toBe(1);
  });

  it('counts eligible rounds, so rounds the detector never ran in do not get a player over the line', () => {
    const [p] = scorePlayers([agg('a', { rounds: 40, eligibleRounds: TUNING.MIN_BOARD_ROUNDS - 1 })]);
    expect(p.ranked).toBe(false);
  });

  it('orders the unranked among themselves by how much there is to look at', () => {
    const got = scorePlayers([
      agg('x', { rounds: 2, eligibleRounds: 2 }),
      agg('y', { rounds: 5, eligibleRounds: 5 }),
    ]);
    expect(got.map((p) => p.steamid)).toEqual(['y', 'x']);
  });
});

describe('missing metrics do not inflate the composite', () => {
  // Found on the live board 2026-09-21: "Ragebot", with 3 rounds and n/a for
  // both occupancy and team gap, ranked 1 of 82. Its composite was a single
  // metric at the 95th percentile with nothing to average it down, while a
  // player measured on all three had to be high on all three to match. Having
  // LESS evidence made it EASIER to reach the top of the board.
  it('ranks a player measured on one metric below one high on all three', () => {
    const scored = scorePlayers([
      agg('sparse', { trackShare: 0.5, occZ: null, teamGap: null }),   // top of the tracking distribution, nothing else
      agg('full', { trackShare: 0.4, occZ: 9, teamGap: 9 }),           // high on all three
      agg('a', { trackShare: 0.01, occZ: 1, teamGap: 1 }),
      agg('b', { trackShare: 0.02, occZ: 2, teamGap: 2 }),
      agg('c', { trackShare: 0.03, occZ: 3, teamGap: 3 }),
    ]);
    expect(scored[0].steamid).toBe('full');
    expect(scored.findIndex((s) => s.steamid === 'sparse')).toBeGreaterThan(0);
  });

  it('treats a missing metric as the middle of the population, not as absent', () => {
    const [sparse] = scorePlayers([
      agg('sparse', { trackShare: 0.5, occZ: null, teamGap: null }),
      agg('a', { trackShare: 0.01, occZ: 1, teamGap: 1 }),
      agg('b', { trackShare: 0.02, occZ: 2, teamGap: 2 }),
    ]).filter((s) => s.steamid === 'sparse');
    // pFid is 1.0 here; the two missing parts count as 0.5 each rather than
    // being dropped, so the composite is 2/3 rather than 1.0.
    expect(sparse.composite).toBeCloseTo((1 + 0.5 + 0.5) / 3, 5);
  });

  it('counts a tracking share nobody could compute as neutral too', () => {
    const [p] = scorePlayers([
      agg('thin', { trackShare: null, occZ: 3, teamGap: 3 }),
      agg('a', { trackShare: 0.01, occZ: 1, teamGap: 1 }),
    ]).filter((s) => s.steamid === 'thin');
    expect(p.pFid).toBeNull();
    expect(p.composite).toBeCloseTo((0.5 + 1 + 1) / 3, 5);
  });

  it('still ranks a fully measured player on their real numbers', () => {
    const scored = scorePlayers([
      agg('x', { trackShare: 0.03, occZ: 3, teamGap: 3 }),
      agg('y', { trackShare: 0.01, occZ: 1, teamGap: 1 }),
    ]);
    expect(scored[0].steamid).toBe('x');
  });
});

const hid = (over: Partial<HiddenMetrics> = {}): HiddenMetrics => ({
  windows: 4, scoreable: 3, fidSum: 0.3, fidMax: 0.2, occ: null, reveals: 4, revealOn: 1,
  byClass: {
    hunter: { scoreable: 3, fidSum: 0.3, occ: null, reveals: 4, revealOn: 1 },
    smoker: { scoreable: 0, fidSum: 0, occ: null, reveals: 0, revealOn: 0 },
    boomer: { scoreable: 0, fidSum: 0, occ: null, reveals: 0, revealOn: 0 },
  },
  gates: { considered: 0, notLive: 0, notTarget: 0, inGrace: 0, tooClose: 0, losUnknown: 0, seen: 0, teamSees: 0, occluded: 0, passed: 0 },
  ...over,
});

const losRows = (steamid: string, n: number, h: HiddenMetrics = hid()) =>
  Array.from({ length: n }, (_, i) => ({ steamid, metrics: m({ losKnown: true, hidden: h }), map: 'm', round: `${steamid}/${i}` }));

describe('the hidden columns', () => {
  it('reads n/a under MIN_BOARD_ROUNDS rounds with line of sight', () => {
    const [a] = aggregate(losRows('p', TUNING.MIN_BOARD_ROUNDS - 1));
    expect(a.losRounds).toBe(TUNING.MIN_BOARD_ROUNDS - 1);
    expect(a.hiddenShare).toBeNull();
    expect(a.revealShare).toBeNull();
    expect(a.byClass.hunter.hiddenShare).toBeNull();
  });

  it('pools D over windows and F over reveals once there is enough', () => {
    // 8 rounds x 3 windows = 24 >= MIN_TRACK_WINDOWS; 8 x 4 reveals = 32 >= MIN_REVEALS.
    const [a] = aggregate(losRows('p', 8));
    expect(a.hiddenScoreable).toBe(24);
    expect(a.hiddenShare).toBeCloseTo(0.1);
    expect(a.reveals).toBe(32);
    expect(a.revealShare).toBeCloseTo(0.25);
    expect(a.byClass.hunter.hiddenShare).toBeCloseTo(0.1);
    expect(a.byClass.hunter.revealShare).toBeCloseTo(0.25);
    expect(a.byClass.smoker).toEqual({ hiddenShare: null, hiddenOccZ: null, revealShare: null });
  });

  it('keeps F at n/a under MIN_REVEALS even with enough rounds', () => {
    const [a] = aggregate(losRows('p', 8, hid({
      reveals: 2, revealOn: 2,
      byClass: { ...hid().byClass, hunter: { ...hid().byClass.hunter, reveals: 2, revealOn: 2 } },
    })));
    expect(a.revealShare).toBeNull();
    expect(a.byClass.hunter.revealShare).toBeNull();
  });

  it('treats a version 4 row as no line of sight, not as zero', () => {
    const [a] = aggregate([{ steamid: 'old', metrics: m(), map: 'm', round: 'r' }]);
    expect(a.losRounds).toBe(0);
    expect(a.hiddenShare).toBeNull();
    expect(a.hiddenOccZ).toBeNull();
  });

  it('ranks the hidden columns by percentile and leaves the composite alone', () => {
    const low = losRows('low', 8, hid({ fidSum: 0.3 }));
    const high = losRows('high', 8, hid({ fidSum: 2.4 }));
    const scored = scorePlayers(aggregate([...low, ...high]));
    const byId = new Map(scored.map((p) => [p.steamid, p]));
    expect(byId.get('high')!.pHidden).toBe(1);
    expect(byId.get('low')!.pHidden).toBe(0);
    // Every other metric is identical, so the composite must be too.
    expect(byId.get('high')!.composite).toBe(byId.get('low')!.composite);
  });
});
