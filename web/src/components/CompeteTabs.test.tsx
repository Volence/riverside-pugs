import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { CompeteTabs, competeTabFor } from './CompeteTabs';
import type { Session } from '../hooks/useLiveState';
import type { Me } from '../api';

const as = (me: Partial<Me>): Session => ({ kind: 'active', me: me as Me });
const withScrims = as({ scrims: true });

afterEach(cleanup);

describe('CompeteTabs', () => {
  it('links each list page at its own route, in the owner\'s order', () => {
    render(<CompeteTabs active="scrims" session={withScrims} />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Scrims', '/scrims'],
      ['Bookings', '/bookings'],
      ['Teams', '/teams'],
      ['Events', '/events'],
    ]);
  });

  it('marks only the active tab as the current page', () => {
    render(<CompeteTabs active="teams" session={withScrims} />);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Teams']);
    expect(current[0].classList.contains('is-active')).toBe(true);
  });

  it.each([
    ['the scrims switch keeps them out', as({ scrims: false })],
    ['an older server sends no flag', as({})],
    ['signed out', { kind: 'anonymous' } as Session],
  ])('leaves Scrims off when %s', (_why, session) => {
    render(<CompeteTabs active="events" session={session} />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Bookings', 'Teams', 'Events']);
  });

  it('is a named navigation landmark, not a tablist of buttons', () => {
    render(<CompeteTabs active="events" session={withScrims} />);
    expect(screen.getByRole('navigation', { name: 'Compete' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('competeTabFor', () => {
  it.each([
    ['/scrims', 'scrims'],
    ['/bookings', 'bookings'],
    ['/booking/7', 'bookings'],
    ['/teams', 'teams'],
    ['/team/rats', 'teams'],
    ['/team/join/abc123', 'teams'],
    ['/events', 'events'],
    ['/event/riverside-cup', 'events'],
    ['/event/riverside-cup/draft', 'events'],
    ['/event/riverside-cup/match/12', 'events'],
  ])('maps %s to %s', (path, tab) => {
    expect(competeTabFor(path)).toBe(tab);
  });

  it.each(['/', '/matches', '/teamspeak', '/eventsx', '/scrimsx', '/admin/events', '/player/1'])('knows nothing of %s', (path) => {
    expect(competeTabFor(path)).toBeNull();
  });
});
