import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/preact';
import type { PlayEntry, PlayMatch, StagePlayView } from '../../api';
import { StagePlay } from './StagePlay';
import { placementText, whenText } from '../../eventFormat';

afterEach(cleanup);

const team = (id: number, name: string, out = false): PlayEntry => ({ id, name, tag: name.slice(0, 3).toUpperCase(), logoKey: null, seed: id, out });
const match = (over: Partial<PlayMatch>): PlayMatch => ({
  id: 1, group: 1, round: 1, slot: 1, a: team(1, 'Rats'), b: team(2, 'Bats'), status: 'waiting', winner: null,
  scoreA: null, scoreB: null, forfeit: false, bye: false, phase: 'waiting', scheduledAt: null, scheduleSource: null, ...over,
});

describe('StagePlay', () => {
  it('draws a bracket: one column per round, scores, the winner marked, TBD for unknown teams', () => {
    const stage: StagePlayView = {
      ordinal: 2, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [
        { group: 1, round: 1, label: 'Semifinals', dates: null, defaultAt: null, window: null, matches: [match({ status: 'done', winner: 'a', scoreA: 1200, scoreB: 900 }), match({ id: 2, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'forfeit', winner: 'b', forfeit: true })] },
        { group: 1, round: 2, label: 'Final', dates: null, defaultAt: null, window: null, matches: [match({ id: 3, a: team(1, 'Rats'), b: null, status: 'pending' })] },
      ],
    };
    render(<StagePlay stage={stage} slug="cup" />);
    expect(screen.getByRole('heading', { name: /Stage 2/ })).toBeTruthy();
    const cols = document.querySelectorAll('.bracket__round');
    expect(cols).toHaveLength(2);
    expect(within(cols[0] as HTMLElement).getByText('Semifinals')).toBeTruthy();
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByText('FF')).toBeTruthy();
    expect(screen.getByText('TBD')).toBeTruthy();
    expect(document.querySelectorAll('.matchcard__side--won')).toHaveLength(2);
  });

  it('draws a table stage: standings with Swiss columns, then the rounds; a bye and an out team are marked', () => {
    const stage: StagePlayView = {
      ordinal: 1, type: 'swiss', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], advanceCount: 2, pairsAsItGoes: true,
      standings: [
        { entry: team(1, 'Rats'), group: 1, rank: 1, groupRank: 1, played: 1, wins: 1, losses: 0, points: 1, buchholz: 0, scoreDiff: 300 },
        { entry: team(3, 'Cats'), group: 1, rank: 2, groupRank: 2, played: 0, wins: 1, losses: 0, points: 1, buchholz: 0, scoreDiff: 0 },
        { entry: team(2, 'Bats', true), group: 1, rank: 3, groupRank: 3, played: 1, wins: 0, losses: 1, points: 0, buchholz: 1, scoreDiff: -300 },
      ],
      rounds: [{ group: 1, round: 1, label: 'Round 1', dates: null, defaultAt: null, window: null, matches: [
        match({ status: 'done', winner: 'a', scoreA: 1200, scoreB: 900 }),
        match({ id: 2, slot: 2, a: team(3, 'Cats'), b: null, status: 'bye', winner: 'a', bye: true }),
      ] }],
    };
    render(<StagePlay stage={stage} slug="cup" />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Buchholz')).toBeTruthy();
    expect(within(table).getByText('+300')).toBeTruthy();
    expect(within(table).getByText('Disqualified')).toBeTruthy();
    expect(screen.getByText('Top 2 advance')).toBeTruthy();
    expect(screen.getByText('Bye')).toBeTruthy();
    expect(screen.getByText('Round 1')).toBeTruthy();
  });

  it('shows a league round\'s week dates next to its label', () => {
    render(<StagePlay slug="cup" stage={{
      ordinal: 1, type: 'league', status: 'live', layout: 'table', advanceCount: null, pairsAsItGoes: false, standings: [], groups: [{ number: 1, label: 'Rounds' }],
      rounds: [{ group: 1, round: 3, label: 'Week 3', dates: { from: '2026-10-26', to: '2026-11-01' }, defaultAt: null, window: null, matches: [] }],
    }} />);
    expect(screen.getByText('Week 3 · Oct 26 to Nov 1')).toBeTruthy();
  });

  it('shows one table per round robin group', () => {
    const s = (id: number, name: string, group: number) => ({ entry: team(id, name), group, rank: id, groupRank: 1, played: 0, wins: 0, losses: 0, points: 0, buchholz: 0, scoreDiff: 0 });
    render(<StagePlay slug="cup" stage={{
      ordinal: 1, type: 'round_robin', status: 'live', layout: 'table', advanceCount: null, pairsAsItGoes: false, rounds: [],
      groups: [{ number: 1, label: 'Group A' }, { number: 2, label: 'Group B' }], standings: [s(1, 'Rats', 1), s(2, 'Bats', 2)],
    }} />);
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.getByText('Group B')).toBeTruthy();
  });

  it('links a match with both teams to its room and shows the room phase', () => {
    const stage: StagePlayView = {
      ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [match({ id: 7, status: 'veto', phase: 'veto' }), match({ id: 8, b: null, status: 'pending', phase: 'pending' }),
        match({ id: 9, slot: 2, status: 'live', phase: 'live' })] }],
    };
    render(<StagePlay stage={stage} slug="cup" />);
    const [link, live] = screen.getAllByRole('link', { name: /Rats.*Bats/ });
    expect(link!.getAttribute('href')).toBe('/event/cup/match/7');
    expect(within(link!).getByText('Veto')).toBeTruthy();
    expect(live!.getAttribute('href')).toBe('/event/cup/match/9');
    expect(within(live!).getByText('Live')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('placementText', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(placementText)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd']);
  });

  it('shows a round\'s default time and window, and a match\'s own time when it differs (plan T4)', () => {
    const stage: StagePlayView = {
      ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{
        group: 1, round: 1, label: 'Week 1', dates: { from: '2026-10-12', to: '2026-10-18' }, defaultAt: '2026-10-14T21:00:00.000Z',
        window: { from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
        matches: [match({ scheduledAt: '2026-10-14T21:00:00.000Z', scheduleSource: 'default' }), match({ id: 2, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), scheduledAt: '2026-10-16T20:00:00.000Z', scheduleSource: 'agreed' })],
      }],
    };
    render(<StagePlay stage={stage} slug="cup" />);
    const header = document.querySelector('.playround .eyebrow')!.textContent!;
    expect(header).toContain('Week 1');
    expect(header).toContain(whenText('2026-10-14T21:00:00.000Z'));
    expect(header).toContain('play by');
    expect(document.querySelectorAll('.matchcard__when')).toHaveLength(1);
    expect(document.querySelector('.matchcard__when')!.textContent).toBe(whenText('2026-10-16T20:00:00.000Z'));
  });
});
