import { describe, it, expect } from 'vitest';
import { chaptersLabel, groupLabel, roundLabel, rulesLines, rulesSummary, stageSummary } from '../src/events/format.js';
import { TEMPLATES } from '../src/rulesets.js';

describe('stage summary', () => {
  it('reads each type with its settings and the advance count', () => {
    expect(stageSummary('swiss', { rounds: 4 }, 8)).toBe('Swiss, 4 rounds, top 8 advance');
    expect(stageSummary('single_elim', { thirdPlace: true }, null)).toBe('Single elimination, third-place match');
    expect(stageSummary('single_elim', { thirdPlace: false }, null)).toBe('Single elimination');
    expect(stageSummary('double_elim', { grandFinalReset: false }, null)).toBe('Double elimination, no grand final reset');
    expect(stageSummary('round_robin', { groups: 1 }, 4)).toBe('Round robin, top 4 advance');
    expect(stageSummary('round_robin', { groups: 2 }, 4)).toBe('Round robin, 2 groups, top 4 advance');
    expect(stageSummary('league', { matches: 16, matchesPerWeek: 2, pairing: 'swiss', seasonStart: null }, 4)).toBe('League, 16 matches, 2 a week, top 4 advance');
  });

  it('labels chapters', () => {
    expect(chaptersLabel(null)).toBe('Every chapter but the finale');
    expect(chaptersLabel(1)).toBe('1 chapter');
    expect(chaptersLabel(3)).toBe('3 chapters');
  });
});

describe('rules lines', () => {
  it('reads the Standard Cup template', () => {
    expect(rulesLines(TEMPLATES['Standard Cup'])).toEqual([
      'Pauses: 3 per team, up to 120 s each',
      'Unpausing needs both teams',
      'Technical pauses: 2 per team per game, 5:00 of technical time in all; past it a pause uses tactical pauses',
      'Reconnect time: 10:00 per team per game; at zero the team forfeits the game',
      'Subs: 2 per match, one may come in mid-chapter for a disconnected player',
      'No-show grace: 15 minutes',
      'Higher seed picks sides',
      'Boss spawns: random, shown in game',
      'Teams are locked once the match is live',
      'Team spectators see only their own side',
    ]);
  });

  it('reads the Casual Scrim template', () => {
    expect(rulesLines(TEMPLATES['Casual Scrim'])).toEqual([
      'Pauses: no limit',
      'Unpausing needs both teams',
      'Reconnect time: 10:00 per team per game; at zero the team forfeits the game',
      'Subs: 2 per match, one may come in mid-chapter for a disconnected player',
      'No-show grace: 15 minutes',
      'The team that did not pick the campaign picks sides',
      'Boss spawns: random, shown in game',
      'Teams are locked once the match is live',
      'A half can be restarted',
    ]);
  });

  it('says the technical time, the reconnect time and the subs (plan T5)', () => {
    const lines = rulesLines(TEMPLATES['Standard Cup']);
    expect(lines).toContain('Technical pauses: 2 per team per game, 5:00 of technical time in all; past it a pause uses tactical pauses');
    expect(lines).toContain('Reconnect time: 10:00 per team per game; at zero the team forfeits the game');
    expect(lines).toContain('Subs: 2 per match, one may come in mid-chapter for a disconnected player');
    expect(rulesLines({ ...TEMPLATES['Standard Cup'], pause: { ...TEMPLATES['Standard Cup'].pause, techPauses: 0 } }).some((l) => l.startsWith('Technical pauses'))).toBe(false);
    expect(rulesLines({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 1, emergency: false, emergencyChargeSeconds: 0 } })).toContain('Subs: 1 per match, between chapters');
  });
});

describe('rules summary', () => {
  it('says the pauses, the side rule and the no-show grace in one line', () => {
    expect(rulesSummary(TEMPLATES.PUG)).toBe('3 pauses of 120 s · coin toss for sides · 10 min no-show grace');
    expect(rulesSummary(TEMPLATES['Standard Cup'])).toBe('3 pauses of 120 s · higher seed picks sides · 15 min no-show grace');
    expect(rulesSummary(TEMPLATES['Casual Scrim'])).toBe('Unlimited pauses · non-picker picks sides · 15 min no-show grace');
  });

  it('reads one pause, no pauses, and unlimited pauses with a length', () => {
    const one = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: 1, seconds: null } };
    expect(rulesSummary(one)).toBe('1 pause · coin toss for sides · 10 min no-show grace');
    const none = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: 0 } };
    expect(rulesSummary(none)).toBe('No pauses · coin toss for sides · 10 min no-show grace');
    const long = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: null, seconds: 60 } };
    expect(rulesSummary(long)).toBe('Unlimited pauses of 60 s · coin toss for sides · 10 min no-show grace');
  });
});

describe('round and group labels (plan T2)', () => {
  it('names elimination rounds from the end', () => {
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 3, 3)).toBe('Final');
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 2, 3)).toBe('Semifinals');
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 2, 4)).toBe('Quarterfinals');
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 1, 5)).toBe('Round 1');
    expect(roundLabel('single_elim', { thirdPlace: true }, 2, 1, 1)).toBe('Third place');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 1, 2, 3)).toBe('Upper round 2');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 1, 3, 3)).toBe('Upper final');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 2, 4, 4)).toBe('Lower final');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 3, 1, 2)).toBe('Grand final');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 3, 2, 2)).toBe('Grand final reset');
  });
  it('names table rounds and league weeks', () => {
    expect(roundLabel('swiss', { rounds: 4 }, 1, 2, 4)).toBe('Round 2');
    expect(roundLabel('round_robin', { groups: 2 }, 2, 3, 3)).toBe('Round 3');
    expect(roundLabel('league', { matches: 4, matchesPerWeek: 1, pairing: 'swiss', seasonStart: null }, 1, 3, 4)).toBe('Week 3');
    expect(roundLabel('league', { matches: 8, matchesPerWeek: 2, pairing: 'swiss', seasonStart: null }, 1, 3, 8)).toBe('Week 2, match 1');
  });
  it('names groups', () => {
    expect(groupLabel('round_robin', 1)).toBe('Group A');
    expect(groupLabel('round_robin', 3)).toBe('Group C');
    expect(groupLabel('double_elim', 2)).toBe('Lower bracket');
    expect(groupLabel('single_elim', 1)).toBe('Bracket');
    expect(groupLabel('swiss', 1)).toBe('Rounds');
  });
});
