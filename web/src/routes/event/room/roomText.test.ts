import { describe, it, expect } from 'vitest';
import { clockText, logText, stepText } from './roomText';
import type { MatchRoomView } from '../../../api';

const v = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null, me: null,
  ...over,
});

describe('roomText', () => {
  it('says whose turn it is and what', () => {
    expect(stepText(v({ next: { kind: 'ban', by: 'b', game: null, step: 3 } }))).toBe('Bats: ban a campaign');
    expect(stepText(v({ next: { kind: 'pick', by: 'a', game: 2, step: 5 } }))).toBe('Rats: pick game 2');
    expect(stepText(v({ next: { kind: 'order', by: 'a', game: null, step: 0 } }))).toBe('Rats: go first or second');
    expect(stepText(v({ next: { kind: 'side', by: 'b', game: 1, step: 4 } }))).toBe('Bats: choose sides for game 1');
    expect(stepText(v({ next: { kind: 'wait', game: 2 } }))).toBe('Game 2 is picked after game 1.');
  });

  it('writes the log in plain sentences, marking automatic steps', () => {
    const view = v({ games: [{ game: 1, campaign: 'no_mercy', campaignName: 'No Mercy', pickedBy: null, sideBy: 'b', firstSurvivors: 'b' }] });
    expect(logText(view, { step: 1, side: 'a', action: 'ban', campaign: 'dead_air', campaignName: 'Dead Air', auto: false, at: '' })).toBe('Rats banned Dead Air');
    expect(logText(view, { step: 0, side: 'a', action: 'second', campaign: null, campaignName: null, auto: true, at: '' })).toBe('Rats chose to go second (automatic)');
    expect(logText(view, { step: 2, side: 'b', action: 'survivors', campaign: null, campaignName: null, auto: false, at: '' })).toBe('Bats chose survivors first');
  });

  it('formats the countdown', () => {
    expect(clockText(65_000)).toBe('1:05');
    expect(clockText(-3)).toBe('0:00');
  });
});
