import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { ProfileEvents } from './ProfileEvents';

describe('ProfileEvents', () => {
  it('renders nothing without events', () => {
    const { container } = render(<ProfileEvents events={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists an event with the team, placement, record and a link per match', () => {
    render(<ProfileEvents events={[{
      slug: 'cup', name: 'Draft Cup', status: 'finished', startsAt: '2026-10-24T00:00:00.000Z', finishedAt: null,
      entry: { id: 1, name: 'Bone Breakage', tag: 'BB', logoKey: null, captain: true, seed: 1 },
      placement: 1, wins: 3, losses: 0,
      matches: [{ id: 5, roundLabel: 'Final', opponent: 'Poop Packers', result: 'win', scoreFor: 1, scoreAgainst: 0, forfeit: false, status: 'done' }],
    }]} />);
    expect(screen.getByRole('link', { name: 'Draft Cup' }).getAttribute('href')).toBe('/event/cup');
    expect(screen.getByText('Champions')).toBeTruthy();
    expect(screen.getByText('3-0')).toBeTruthy();
    expect(screen.getByText(/Bone Breakage \[BB\] · Captain/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /vs Poop Packers/ }).getAttribute('href')).toBe('/event/cup/match/5');
  });
});
