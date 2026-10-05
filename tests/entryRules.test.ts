import { describe, it, expect } from 'vitest';
import * as R from '../src/events/entryRules.js';
import { defaultEligibility, defaultRoster, nextStatusAllowed } from '../src/events/validate.js';

const S = (n: number) => `765611990000${String(n).padStart(5, '0')}`;
const facts = (over: Partial<R.PlayerFacts> = {}): R.PlayerFacts => ({ open: true, good: true, pugs: 10, discord: true, sr: 1500, ...over });

describe('problemsOf', () => {
  const e = { ...defaultEligibility(), srFloor: 1000, srCeiling: 2000 };
  it('passes an eligible player', () => expect(R.problemsOf(e, facts(), 'starter')).toEqual([]));
  it('names every failing rule', () => {
    expect(R.problemsOf(e, facts({ good: false, open: false, pugs: 2, discord: false, sr: 900 }), 'starter'))
      .toEqual(['standing', 'closed', 'pugs', 'discord', 'sr_low']);
    expect(R.problemsOf(e, facts({ sr: 2100 }), 'sub')).toEqual(['sr_high']);
  });
  it('holds a coach only to standing, the switch and Discord', () => {
    expect(R.problemsOf(e, facts({ pugs: 0, sr: 50 }), 'coach')).toEqual([]);
    expect(R.problemsOf(e, facts({ discord: false }), 'coach')).toEqual(['discord']);
  });
  it('skips Discord when the event does not require it', () => {
    expect(R.problemsOf({ ...e, requireDiscord: false }, facts({ discord: false }), 'starter')).toEqual([]);
  });
  it('says each problem as a sentence with the numbers', () => {
    expect(R.problemText('pugs', e, facts({ pugs: 2 }))).toBe('2 of 5 completed PUGs');
    expect(R.problemText('sr_low', e, facts({ sr: 900 }))).toBe('SR 900 is below the floor of 1000');
    expect(R.problemText('sr_high', e, facts({ sr: 2100 }))).toBe('SR 2100 is above the ceiling of 2000');
  });
});

describe('parseEntryRoster', () => {
  const rules = defaultRoster(); // maxSubs 2
  it('takes 4 starters, subs up to the limit and one coach', () => {
    const r = R.parseEntryRoster({ starters: [S(1), S(2), S(3), S(4)], subs: [S(5)], coach: S(6) }, rules);
    expect(r).toEqual({ ok: true, value: { starters: [S(1), S(2), S(3), S(4)], subs: [S(5)], coach: S(6) } });
  });
  it('defaults subs to none and coach to null', () => {
    expect(R.parseEntryRoster({ starters: [S(1), S(2), S(3), S(4)] }, rules)).toEqual({ ok: true, value: { starters: [S(1), S(2), S(3), S(4)], subs: [], coach: null } });
  });
  it.each([
    ['three starters', { starters: [S(1), S(2), S(3)] }],
    ['five starters', { starters: [S(1), S(2), S(3), S(4), S(5)] }],
    ['too many subs', { starters: [S(1), S(2), S(3), S(4)], subs: [S(5), S(6), S(7)] }],
    ['a player twice', { starters: [S(1), S(2), S(3), S(4)], subs: [S(1)] }],
    ['coach also a starter', { starters: [S(1), S(2), S(3), S(4)], coach: S(1) }],
    ['not a SteamID', { starters: [S(1), S(2), S(3), 'bob'] }],
    ['not an object', 'roster'],
  ])('refuses %s', (_, raw) => expect(R.parseEntryRoster(raw, rules)).toEqual({ ok: false, error: 'bad_entry_roster' }));
});

describe('placeEntries', () => {
  const row = (id: number, at: string, status = 'registered') => ({ id, created_at: at, status });
  it('places in registration order up to the cap and waitlists the rest, skipping dropped', () => {
    const rows = [row(3, '2026-10-02'), row(1, '2026-10-01'), row(2, '2026-10-01T05'), row(4, '2026-10-03', 'dropped'), row(5, '2026-10-04')];
    expect(R.placeEntries(rows, 2)).toEqual({ placed: [1, 2], waitlist: [3, 5] });
    expect(R.placeEntries(rows, null)).toEqual({ placed: [1, 2, 3, 5], waitlist: [] });
  });
  it('breaks a tie on the timestamp by id', () => {
    expect(R.placeEntries([row(9, 'x'), row(7, 'x')], 1)).toEqual({ placed: [7], waitlist: [9] });
  });
});

describe('seedOrder and averageSr', () => {
  it('seeds highest SR first, ties by registration order then id', () => {
    expect(R.seedOrder([
      { id: 1, sr: 1500, created_at: '2026-10-02' }, { id: 2, sr: 1800, created_at: '2026-10-03' },
      { id: 3, sr: 1500, created_at: '2026-10-01' }, { id: 4, sr: 1500, created_at: '2026-10-01' },
    ])).toEqual([2, 3, 4, 1]);
  });
  it('averages and rounds, 0 for none', () => {
    expect(R.averageSr([1000, 1001])).toBe(1001);
    expect(R.averageSr([])).toBe(0);
  });
});

describe('checkinTimes and rosterLocked', () => {
  it('counts the window back from the start', () => {
    expect(R.checkinTimes('2026-10-10T20:00:00.000Z', { enabled: true, opensMinutes: 60, closesMinutes: 15 }))
      .toEqual({ opensAt: '2026-10-10T19:00:00.000Z', closesAt: '2026-10-10T19:45:00.000Z' });
  });
  it('locks at a time once it passes, never on after_round in T1b, never on none', () => {
    expect(R.rosterLocked({ kind: 'at', at: '2026-10-05T00:00:00.000Z' }, '2026-10-04T23:59:59.000Z')).toBe(false);
    expect(R.rosterLocked({ kind: 'at', at: '2026-10-05T00:00:00.000Z' }, '2026-10-05T00:00:00.000Z')).toBe(true);
    expect(R.rosterLocked({ kind: 'after_round', stage: 1, round: 2 }, '2030-01-01T00:00:00.000Z')).toBe(false);
    expect(R.rosterLocked({ kind: 'none' }, '2030-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('nextStatusAllowed', () => {
  it('lets registration move to check-in', () => expect(nextStatusAllowed('registration', 'checkin')).toBe(true));
});
