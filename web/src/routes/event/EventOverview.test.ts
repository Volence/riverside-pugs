import { describe, expect, it } from 'vitest';
import type { EventView } from '../../api';
import { milestones, roundName, teamInitials } from './EventOverview';

const draftEvent = (over: Partial<EventView> = {}): EventView => ({
  slug: 'cup', name: 'Cup', status: 'registration', entryKind: 'draft', official: true, organizerName: null,
  bannerKey: null, startsAt: '2026-10-24T00:00:00.000Z', description: '', teamCap: null,
  eligibility: { minPugs: 1, requireDiscord: true, srFloor: null, srCeiling: null },
  checkin: { enabled: false, opensMinutes: 60, closesMinutes: 15 },
  roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  stages: [{
    ordinal: 1, type: 'single_elim', summary: 'Single elimination, third-place match', veto: 'Bo1', chapters: 'Every chapter but the finale',
    scheduling: 'rolling', rulesetName: 'Standard Cup', rules: [], gameConfig: 'Standard', campaigns: [],
    roundTimes: [{ round: 2, at: '2026-10-25T00:00:00.000Z' }, { round: 3, at: '2026-10-25T00:00:00.000Z' }],
  }],
  entries: [], play: [], finishedAt: null, cancelledAt: null, cancelReason: null,
  lockedAt: null, checkinOpensAt: null, checkinClosesAt: null,
  draft: { signupsCloseAt: '2026-10-23T22:00:00.000Z', draftAt: '2026-10-23T23:00:00.000Z', signups: 31, names: [], cut: null },
  ...over,
});

describe('event timeline', () => {
  it('names bracket rounds back from the final, and falls back to a number', () => {
    expect([1, 2, 3].map((r) => roundName(r, 3))).toEqual(['Quarterfinals', 'Semifinals', 'Final']);
    expect(roundName(1, 5)).toBe('Round 1');
    expect(roundName(2, null)).toBe('Round 2');
  });

  it('puts a draft night in order and folds rounds that share a time into one step', () => {
    // 31 signups make 7 teams, so the bracket has 3 rounds and rounds 2 and 3 are the semis and the final.
    expect(milestones(draftEvent()).map((m) => [m.label, m.at])).toEqual([
      ['Signups close', '2026-10-23T22:00:00.000Z'],
      ['Draft night', '2026-10-23T23:00:00.000Z'],
      ['First matches', '2026-10-24T00:00:00.000Z'],
      ['Semifinals and final', '2026-10-25T00:00:00.000Z'],
    ]);
  });

  it('leaves out round times at or before the start, and works without roundTimes from an older server', () => {
    const early = draftEvent();
    early.stages[0]!.roundTimes = [{ round: 1, at: '2026-10-24T00:00:00.000Z' }];
    expect(milestones(early).map((m) => m.label)).toEqual(['Signups close', 'Draft night', 'First matches']);
    const old = draftEvent();
    delete old.stages[0]!.roundTimes;
    expect(milestones(old)).toHaveLength(3);
  });

  it('gives a team event its check-in and start', () => {
    const ev = draftEvent({ entryKind: 'team', draft: null, checkinOpensAt: '2026-10-23T23:00:00.000Z' });
    ev.stages[0]!.roundTimes = [];
    expect(milestones(ev).map((m) => m.label)).toEqual(['Check-in opens', 'Starts']);
  });
});

describe('team initials', () => {
  it('uses the tag, else the initials of the name without a leading Team', () => {
    expect(teamInitials({ name: 'Bone Breakage', tag: 'BB' })).toBe('BB');
    expect(teamInitials({ name: 'Team Icy Inferno', tag: '' })).toBe('II');
    expect(teamInitials({ name: 'Team KoRn', tag: '' })).toBe('KO');
    expect(teamInitials({ name: 'Team P $tache #L4DRevival', tag: '' })).toBe('PT');
    expect(teamInitials({ name: '>>>>', tag: '' })).toBe('>>');
  });
});
