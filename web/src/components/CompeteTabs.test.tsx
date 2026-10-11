import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { CompeteTabs, competeTabFor } from './CompeteTabs';

afterEach(cleanup);

describe('CompeteTabs', () => {
  it('links each list page at its own route, in the owner\'s order', () => {
    render(<CompeteTabs active="scrims" />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Scrims', '/scrims'],
      ['Bookings', '/bookings'],
      ['Teams', '/teams'],
      ['Events', '/events'],
    ]);
  });

  it('marks only the active tab as the current page', () => {
    render(<CompeteTabs active="teams" />);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Teams']);
    expect(current[0].classList.contains('is-active')).toBe(true);
  });

  it('is a named navigation landmark, not a tablist of buttons', () => {
    render(<CompeteTabs active="events" />);
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
