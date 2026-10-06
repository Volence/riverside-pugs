import { describe, it, expect } from 'vitest';
import { clockText, gameTitle, gameLine, logText, resultLine, seriesLine, stepText } from './roomText';
import type { MatchRoomView, RoomGame } from '../../../api';

const v = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null, me: null,
  series: null, server: null, confirm: null, dispute: null,
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
    const view = v({});
    expect(logText(view, { step: 1, side: 'a', action: 'ban', campaign: 'dead_air', campaignName: 'Dead Air', auto: false, at: '' })).toBe('Rats banned Dead Air');
    expect(logText(view, { step: 0, side: 'a', action: 'second', campaign: null, campaignName: null, auto: true, at: '' })).toBe('Rats chose to go second (automatic)');
    expect(logText(view, { step: 2, side: 'b', action: 'survivors', campaign: null, campaignName: null, auto: false, at: '' })).toBe('Bats chose survivors first');
  });

  it('formats the countdown', () => {
    expect(clockText(65_000)).toBe('1:05');
    expect(clockText(-3)).toBe('0:00');
  });

  it('titles games and tiebreaks, writes a game line with scores, and the series and result lines', () => {
    const g = (over: Partial<RoomGame>): RoomGame => ({
      id: 1, game: 1, ordinal: 1, tiebreak: false, campaign: 'no_mercy', campaignName: 'No Mercy', map: null, pickedBy: null, sideBy: 'b', firstSurvivors: 'b',
      matchId: null, state: 'upcoming', scoreA: null, scoreB: null, winner: null, forfeit: null, live: null, ...over,
    });
    const view = v({ series: { bestOf: 3, totalScore: false, winsA: 1, winsB: 1, totalA: 900, totalB: 900, over: false, winner: null } });
    expect(gameTitle(g({}))).toBe('Game 1');
    expect(gameTitle(g({ tiebreak: true, ordinal: 11 }))).toBe('Tiebreak of game 1');
    expect(gameLine(view, g({}))).toBe('Game 1 · No Mercy · Bats start as survivors');
    expect(gameLine(view, g({ state: 'live', matchId: 7, live: { map: 'l4d_vs_hospital03_sewers', scoreA: 80, scoreB: 120 } }))).toBe('Game 1 · No Mercy · live on l4d_vs_hospital03_sewers · Rats 80 - 120 Bats');
    expect(gameLine(view, g({ state: 'done', scoreA: 600, scoreB: 400, winner: 'a' }))).toBe('Game 1 · No Mercy · Rats 600 - 400 Bats');
    expect(gameLine(view, g({ tiebreak: true, ordinal: 11, map: 'l4d_vs_hospital04_interior', state: 'done', scoreA: 20, scoreB: 50, winner: 'b' }))).toBe('Tiebreak of game 1 · No Mercy, l4d_vs_hospital04_interior · Rats 20 - 50 Bats');
    // A !gg: the side ahead on score forfeited, so the line names the forfeit and who won (T3b final review).
    expect(gameLine(view, g({ state: 'done', scoreA: 600, scoreB: 400, winner: 'b', forfeit: 'a' }))).toBe('Game 1 · No Mercy · Rats 600 - 400 Bats · FF: Rats forfeited, Bats win');
    expect(gameLine(view, g({ state: 'done', scoreA: null, scoreB: null, winner: 'a', forfeit: 'b' }))).toBe('Game 1 · No Mercy · FF: Bats forfeited, Rats win');
    expect(seriesLine(view)).toBe('Best of 3 · Rats 1 - 1 Bats');
    expect(seriesLine(v({ series: { bestOf: 2, totalScore: true, winsA: 0, winsB: 0, totalA: 1000, totalB: 1050, over: true, winner: 'b' } }))).toBe('Two games, total score · Rats 1000 - 1050 Bats');
    expect(resultLine(v({ series: { bestOf: 3, totalScore: false, winsA: 2, winsB: 1, totalA: 0, totalB: 0, over: true, winner: 'a' } }))).toBe('Rats beat Bats 2 games to 1.');
    expect(resultLine(v({ series: { bestOf: 2, totalScore: true, winsA: 0, winsB: 0, totalA: 1000, totalB: 1050, over: true, winner: 'b' } }))).toBe('Bats beat Rats 1050 to 1000 on total score.');
  });
});
