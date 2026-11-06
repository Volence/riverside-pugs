import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { NEWS_SECTION, STATS_SECTION, SectionTabs, sectionTabFor } from './SectionTabs';

afterEach(cleanup);

describe('SectionTabs', () => {
  it('links each page of the section at its own route, and marks only the active one', () => {
    render(<SectionTabs section={NEWS_SECTION} active="patch" />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['News', '/news'], ['Patch notes', '/patch-notes'], ['Change log', '/balance'],
    ]);
    expect(links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['Patch notes']);
    expect(screen.getByRole('navigation', { name: 'News' })).toBeTruthy();
  });
});

describe('sectionTabFor', () => {
  it('maps every route of a section to its tab, posts and Game values included', () => {
    expect(sectionTabFor(NEWS_SECTION, '/news')).toBe('news');
    expect(sectionTabFor(NEWS_SECTION, '/news/12')).toBe('news');
    expect(sectionTabFor(NEWS_SECTION, '/patch-notes')).toBe('patch');
    expect(sectionTabFor(NEWS_SECTION, '/balance')).toBe('changelog');
    expect(sectionTabFor(NEWS_SECTION, '/balance/values')).toBe('changelog');
    expect(sectionTabFor(STATS_SECTION, '/matches')).toBe('matches');
    expect(sectionTabFor(STATS_SECTION, '/maps')).toBe('campaigns');
  });

  it('knows nothing outside the section', () => {
    expect(sectionTabFor(NEWS_SECTION, '/newsletter')).toBeNull();
    expect(sectionTabFor(STATS_SECTION, '/match/4')).toBeNull();
    expect(sectionTabFor(STATS_SECTION, '/custom-campaigns')).toBeNull();
  });
});
