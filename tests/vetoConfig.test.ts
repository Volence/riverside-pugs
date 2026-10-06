import { describe, it, expect } from 'vitest';
import { checkVeto, parseVetoConfig, presetConfig, presetOf, vetoFamily, vetoSummary, type VetoConfig } from '../src/events/vetoConfig.js';

const base: VetoConfig = { games: 1, banTo: 1, firstBan: 'higher_chooses', firstPick: 'first', laterPicks: 'alternate', lateBans: 0, sides: 'non_picker' };

describe('veto presets', () => {
  it('fills the knobs for each preset from the pool size', () => {
    expect(presetConfig('ban_to_one', 7)).toEqual(base);
    expect(presetConfig('home_away', 7)).toEqual({ ...base, games: 2, banTo: 7 });
    expect(presetConfig('pick_ban', 7)).toEqual({ ...base, games: 3, banTo: 5, lateBans: 2 });
    expect(presetConfig('pick_ban', 5)).toEqual({ ...base, games: 3, banTo: 3, lateBans: 0 });
    expect(presetConfig('loser_picks', 7)).toEqual({ ...base, games: 3, banTo: 3, firstPick: 'higher', laterPicks: 'loser' });
  });

  it('recognises a preset and calls anything else custom', () => {
    expect(presetOf(presetConfig('loser_picks', 7), 7)).toBe('loser_picks');
    expect(presetOf(presetConfig('pick_ban', 7), 7)).toBe('pick_ban');
    expect(presetOf({ ...presetConfig('loser_picks', 7), banTo: 4 }, 7)).toBe('custom');
  });

  it('maps every config to the old veto_type family', () => {
    expect(vetoFamily(base)).toBe('ban_to_one');
    expect(vetoFamily(presetConfig('home_away', 4))).toBe('home_away');
    expect(vetoFamily(presetConfig('loser_picks', 7))).toBe('pick_ban');
    expect(vetoFamily({ ...base, games: 5, banTo: 5 })).toBe('pick_ban');
  });
});

describe('checkVeto', () => {
  it('accepts every preset on a pool big enough for it', () => {
    for (const p of ['ban_to_one', 'home_away', 'pick_ban', 'loser_picks'] as const) expect(checkVeto(presetConfig(p, 7), 7)).toBe('ok');
  });

  it('needs at least one campaign per game left after the bans, and no more than the pool', () => {
    expect(checkVeto({ ...base, games: 3, banTo: 2 }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, banTo: 8 }, 7)).toBe('bad_pool_for_veto');
    expect(checkVeto({ ...base, games: 3, banTo: 3 }, 2)).toBe('bad_pool_for_veto');
  });

  it('refuses loser picks in a total score Bo2, and late bans that leave nothing to play', () => {
    expect(checkVeto({ ...base, games: 2, banTo: 2, laterPicks: 'loser' }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, games: 3, banTo: 5, lateBans: 3 }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, games: 3, banTo: 5, lateBans: 2 }, 7)).toBe('ok');
    expect(checkVeto({ ...base, games: 3, banTo: 3, laterPicks: 'loser', lateBans: 1 }, 7)).toBe('bad_veto');
  });

  it('refuses late bans in a total score Bo2, which has no last game to save one for', () => {
    expect(checkVeto({ ...base, games: 2, banTo: 4, lateBans: 1 }, 7)).toBe('bad_veto');
  });

  it('refuses unknown values', () => {
    expect(checkVeto({ ...base, games: 4 as 1 }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, sides: 'nobody' as 'coin' }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, banTo: 1.5 }, 7)).toBe('bad_veto');
  });
});

describe('parseVetoConfig', () => {
  it('reads a whole config and normalises a Bo1 (no later picks, no late bans)', () => {
    const r = parseVetoConfig({ ...base, banTo: 3, firstPick: 'higher', laterPicks: 'loser' }, 7);
    expect(r).toEqual({ ok: true, value: { ...base, banTo: 3, firstPick: 'higher', laterPicks: 'alternate', lateBans: 0 } });
  });

  it('refuses a non-object or a missing knob', () => {
    expect(parseVetoConfig('ban_to_one', 7)).toEqual({ ok: false, error: 'bad_veto' });
    const { sides: _drop, ...noSides } = base;
    expect(parseVetoConfig(noSides, 7)).toEqual({ ok: false, error: 'bad_veto' });
  });
});

describe('vetoSummary', () => {
  it('says the owner\'s format in one sentence', () => {
    expect(vetoSummary(presetConfig('loser_picks', 7), 7)).toBe(
      'Bo3: ban down to 3, the higher seed chooses to go first or second, the higher seed picks game 1, the loser of each game picks the next, the team that did not pick chooses sides.',
    );
  });

  it('says a Bo1 ban to one and a home and away', () => {
    expect(vetoSummary(base, 7)).toBe('Bo1: ban down to 1, the higher seed chooses to go first or second, the team that did not pick chooses sides.');
    expect(vetoSummary(presetConfig('home_away', 4), 4)).toBe(
      'Bo2, total score: no bans, the higher seed chooses to go first or second, the team that goes first picks game 1, the teams take turns picking the rest, the team that did not pick chooses sides.',
    );
  });
});
