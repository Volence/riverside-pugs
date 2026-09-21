import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { ChemistryPanel } from './Chemistry';

afterEach(cleanup);

const line = (name: string, games: number, wins: number) =>
  ({ steamid: `7656119800000000${name.length}`, name, games, wins, winRate: wins / games });

describe('ChemistryPanel', () => {
  it('renders nothing at all when there is no line to show', () => {
    const { container } = render(
      <ChemistryPanel chemistry={{ mostPlayedWith: null, bestWith: null, worstAgainst: null }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for an older payload with no chemistry field', () => {
    const { container } = render(<ChemistryPanel chemistry={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count for most played with and a percentage for the two rates', () => {
    render(
      <ChemistryPanel
        chemistry={{ mostPlayedWith: line('ann', 12, 7), bestWith: line('bobby', 7, 5), worstAgainst: line('cat', 6, 1) }}
      />,
    );
    expect(screen.getByText('Most played with')).toBeTruthy();
    expect(screen.getByText('12 games')).toBeTruthy();
    expect(screen.getByText('71% over 7')).toBeTruthy();
    expect(screen.getByText('17% over 6')).toBeTruthy();
    expect((screen.getByText('ann') as HTMLAnchorElement).getAttribute('href')).toContain('/player/');
  });

  it('leaves out a gated line that nobody cleared, rather than showing it empty', () => {
    render(<ChemistryPanel chemistry={{ mostPlayedWith: line('ann', 1, 1), bestWith: null, worstAgainst: null }} />);
    expect(screen.getByText('1 game')).toBeTruthy();
    expect(screen.queryByText('Best with')).toBeNull();
    expect(screen.queryByText('Worst against')).toBeNull();
  });
});
