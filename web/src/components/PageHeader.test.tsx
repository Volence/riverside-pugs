import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { PageHeader, Figures, Figure } from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders eyebrow, title, aside and figures', () => {
    render(
      <PageHeader eyebrow="Season 1" title="Leaderboard" aside={<span>24 players</span>}>
        <Figures>
          <Figure label="Players" value={24} />
          <Figure label="Top rating" value={1151} tone="rating" sub="fake_11" />
        </Figures>
      </PageHeader>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Leaderboard');
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.getByText('24 players')).toBeTruthy();
    expect(screen.getByText('Players')).toBeTruthy();
    expect(screen.getByText('1151').classList.contains('figure__value--rating')).toBe(true);
    expect(screen.getByText('fake_11')).toBeTruthy();
  });

  it('omits the eyebrow and aside when not given', () => {
    const { container } = render(<PageHeader title="Replays" />);
    expect(container.querySelector('.page-head__eyebrow')).toBeNull();
    expect(container.querySelector('.page-head__aside')).toBeNull();
  });
});
