import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { PlacingTag, RankBadge } from './SeasonRank';
import { SrDelta } from './bits';

afterEach(cleanup);

describe('season rank bits', () => {
  it('a rank badge names the division and colours by tier', () => {
    const { container } = render(<RankBadge rank={{ index: 7, tier: 'Gold', division: 'II', name: 'Gold II', floor: 2067, next: 2233 }} />);
    expect(screen.getByText('Gold II')).toBeTruthy();
    expect(container.querySelector('.rankbadge--gold')).toBeTruthy();
  });

  it('a badge from a frozen name alone still colours by tier', () => {
    const { container } = render(<RankBadge name="Master I" />);
    expect(container.querySelector('.rankbadge--master')).toBeTruthy();
  });

  it('placing says how far through, never an SR', () => {
    render(<PlacingTag placing={{ played: 2, of: 5 }} />);
    expect(screen.getByText('Placing 2/5')).toBeTruthy();
  });

  it('a placement game shows no SR change, the placing game the rank', () => {
    render(<SrDelta value={null} placement={{ kind: 'placing', played: 3, of: 5 }} />);
    expect(screen.getByText('Placing 3/5')).toBeTruthy();
    cleanup();
    render(<SrDelta value={null} placement={{ kind: 'placed' }} placedRank="Silver I" />);
    expect(screen.getByText('Placed Silver I')).toBeTruthy();
    cleanup();
    render(<SrDelta value={42} />);
    expect(screen.getByText('+42')).toBeTruthy();
  });
});
