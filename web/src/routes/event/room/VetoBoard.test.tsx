import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { VetoBoard } from './VetoBoard';

afterEach(cleanup);
const base = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: 'Bo1: ban down to 1.',
  pool: [
    { slug: 'no_mercy', name: 'No Mercy', state: 'open', by: null, game: null },
    { slug: 'dead_air', name: 'Dead Air', state: 'banned', by: 'b', game: null },
  ],
  log: [], games: [], next: { kind: 'ban', by: 'a', game: null, step: 2 }, lineups: { a: null, b: null, aLocked: false, bLocked: false },
  holdReason: null, result: null, me: { side: 'a', manager: true, playable: [], defaultFour: null },
  series: null, server: null, confirm: null, dispute: null, frozen: false, schedule: null, pauses: [], ...over,
});

describe('VetoBoard', () => {
  it('lets the manager whose turn it is ban an open campaign, sending the step it saw', () => {
    const act = vi.fn();
    render(<VetoBoard v={base({})} busy={false} onAct={act} />);
    expect(screen.getByText('Rats: ban a campaign')).toBeTruthy();
    expect(screen.getByText('Banned by Bats')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ban No Mercy' }));
    expect(act).toHaveBeenCalledWith(2, 'ban', 'no_mercy');
  });

  it('shows no buttons to the other team, a member, or a viewer', () => {
    for (const me of [{ side: 'b' as const, manager: true, playable: [], defaultFour: null }, { side: 'a' as const, manager: false, playable: [], defaultFour: null }, null]) {
      render(<VetoBoard v={base({ me })} busy={false} onAct={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Ban No Mercy' })).toBeNull();
      cleanup();
    }
  });

  it('offers go first or second, and survivors or infected first', () => {
    const act = vi.fn();
    const { rerender } = render(<VetoBoard v={base({ next: { kind: 'order', by: 'a', game: null, step: 0 } })} busy={false} onAct={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go second' }));
    expect(act).toHaveBeenCalledWith(0, 'second', null);
    rerender(<VetoBoard v={base({ next: { kind: 'side', by: 'a', game: 1, step: 3 } })} busy={false} onAct={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Infected first' }));
    expect(act).toHaveBeenCalledWith(3, 'infected', null);
  });

  describe('the turn banner, the step list and each team\'s share (owner 2026-10-23)', () => {
    // Bo1, 3 campaigns down to 1... here 3 bans then a pick: a bans 1 and 3, b bans 2, a picks, b chooses sides.
    const plan: MatchRoomView['plan'] = [
      { kind: 'ban', by: 'a', game: null, state: 'done', tentative: false },
      { kind: 'ban', by: 'b', game: null, state: 'done', tentative: false },
      { kind: 'pick', by: 'a', game: 1, state: 'now', tentative: false },
      { kind: 'side', by: 'b', game: 1, state: 'later', tentative: false },
    ];

    it('tells the picking captain in capitals that this is the PICK, with green pick buttons', () => {
      render(<VetoBoard v={base({ plan, next: { kind: 'pick', by: 'a', game: 1, step: 2 } })} busy={false} onAct={() => {}} />);
      expect(screen.getByText('Your turn: PICK the campaign you will play')).toBeTruthy();
      expect(screen.getByText(/This is not a ban/)).toBeTruthy();
      const btn = screen.getByRole('button', { name: 'Pick No Mercy' });
      expect(btn.className).toContain('vetobtn--pick');
    });

    it('tells the banning captain it is a BAN, and the other team who is acting', () => {
      render(<VetoBoard v={base({ plan })} busy={false} onAct={() => {}} />);
      expect(screen.getByText('Your turn: BAN a campaign')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Ban No Mercy' }).className).toContain('vetobtn--ban');
      cleanup();
      render(<VetoBoard v={base({ plan, me: { side: 'b', manager: true, playable: [], defaultFour: null } })} busy={false} onAct={() => {}} />);
      expect(screen.getByText('Rats is banning a campaign')).toBeTruthy();
    });

    it('lists every step in order, done, now and later, and what each team gets', () => {
      render(<VetoBoard v={base({ plan, next: { kind: 'pick', by: 'a', game: 1, step: 2 } })} busy={false} onAct={() => {}} />);
      const steps = screen.getByRole('list', { name: 'Veto order' }).querySelectorAll('li');
      expect([...steps].map((li) => li.textContent)).toEqual(['Ban 1: Rats', 'Ban 2: Bats', 'PICK the campaign: Rats', 'Sides for game 1: Bats']);
      expect(steps[0]!.className).toContain('is-done');
      expect(steps[2]!.className).toContain('is-now');
      expect(screen.getByText('You (Rats): 1 ban, picks the campaign')).toBeTruthy();
      expect(screen.getByText('Bats: 1 ban, chooses sides')).toBeTruthy();
    });

    it('explains the trade when the higher seed chooses to go first or second', () => {
      const open: MatchRoomView['plan'] = [
        { kind: 'order', by: 'a', game: null, state: 'now', tentative: false },
        { kind: 'ban', by: 'a', game: null, state: 'later', tentative: true },
        { kind: 'ban', by: 'b', game: null, state: 'later', tentative: true },
        { kind: 'pick', by: 'a', game: 1, state: 'later', tentative: true },
        { kind: 'side', by: 'b', game: 1, state: 'later', tentative: true },
      ];
      render(<VetoBoard v={base({ plan: open, next: { kind: 'order', by: 'a', game: null, step: 0 } })} busy={false} onAct={() => {}} />);
      expect(screen.getByText('Your turn: go first or second')).toBeTruthy();
      expect(screen.getByText('Go first and you get ban 1, the pick of game 1. Go second and you get ban 2, the side choice for game 1.')).toBeTruthy();
      expect(screen.getByText('Ban 1: the team that goes first')).toBeTruthy();
    });
  });
});
