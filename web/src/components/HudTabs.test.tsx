import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { HudTabs, hudTabFor } from './HudTabs';

afterEach(cleanup);

describe('HudTabs', () => {
  it('links each tool at its own route, in order', () => {
    render(<HudTabs active="hud" />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['HUD editor', '/hud'],
      ['Crosshair', '/crosshair'],
      ['Community', '/community'],
    ]);
  });

  it('marks only the active tab as the current page', () => {
    render(<HudTabs active="crosshair" />);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Crosshair']);
    expect(current[0].classList.contains('is-active')).toBe(true);
  });

  it('is a named navigation landmark, not a tablist of buttons', () => {
    render(<HudTabs active="community" />);
    expect(screen.getByRole('navigation', { name: 'HUD tools' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('hudTabFor', () => {
  it('maps every route of the section to its tab', () => {
    expect(hudTabFor('/hud')).toBe('hud');
    expect(hudTabFor('/crosshair')).toBe('crosshair');
    expect(hudTabFor('/community')).toBe('community');
    expect(hudTabFor('/community/12')).toBe('community');
  });

  it('knows nothing outside the section', () => {
    expect(hudTabFor('/')).toBeNull();
    expect(hudTabFor('/hudson')).toBeNull();
    expect(hudTabFor('/communityx')).toBeNull();
    expect(hudTabFor('/maps')).toBeNull();
  });
});
