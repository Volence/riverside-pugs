import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { TitleTag, EndorsementCounts } from './TitleTag';

afterEach(cleanup);

describe('TitleTag', () => {
  it('is a word, not a number', () => {
    render(<TitleTag kind="vibes" />);
    expect(screen.getByText('Good vibes').classList.contains('titletag')).toBe(true);
  });

  it('renders nothing without a title', () => {
    expect(render(<TitleTag kind={null} />).container.innerHTML).toBe('');
    expect(render(<TitleTag />).container.innerHTML).toBe('');
  });
});

describe('EndorsementCounts', () => {
  it('shows a count per kind and the per match rate', () => {
    render(<EndorsementCounts endorsements={{ counts: { caller: 17, clutch: 4, vibes: 9 }, total: 30, perMatch: 0.42, title: 'caller' }} />);
    expect(screen.getByText('Caller')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('Good vibes')).toBeTruthy();
    expect(screen.getByText('0.42')).toBeTruthy();
  });

  it('renders nothing until somebody has been endorsed', () => {
    const none = { counts: { caller: 0, clutch: 0, vibes: 0 }, total: 0, perMatch: 0, title: null };
    expect(render(<EndorsementCounts endorsements={none} />).container.innerHTML).toBe('');
    expect(render(<EndorsementCounts endorsements={undefined} />).container.innerHTML).toBe('');
  });
});
