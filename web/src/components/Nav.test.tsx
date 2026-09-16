import { describe, it, expect } from 'vitest';
import { NAV_LINKS } from './Nav';

describe('NAV_LINKS', () => {
  it('offers the crosshair maker', () => {
    expect(NAV_LINKS.find(([href]) => href === '/crosshair.html')).toBeTruthy();
  });

  it('gives every static page a target so the SPA router does not swallow it', () => {
    // preact-iso intercepts same-origin clicks unless target is absent or
    // _self (router.js:45). A static .html page is not a route, so being
    // intercepted would land the user on the SPA's not-found instead of the
    // file. Anything ending .html must therefore opt out.
    for (const [href, , target] of NAV_LINKS) {
      if (href.endsWith('.html')) expect(target).toBeTruthy();
      else expect(target).toBeUndefined();
    }
  });
});

import { render, cleanup } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { afterEach } from 'vitest';
import { Nav } from './Nav';

afterEach(cleanup);

describe('Nav', () => {
  it('calls the maps route Campaigns and keeps its path', () => {
    const maps = NAV_LINKS.find(([href]) => href === '/maps');
    expect(maps?.[1]).toBe('Campaigns');
  });

  it('shows the wordmark and no live indicator when nothing is live', () => {
    const { container } = render(
      <LocationProvider><Nav session={{ kind: 'anonymous' }} state={null} /></LocationProvider>,
    );
    expect(container.querySelector('.nav__brand')?.textContent).toBe('Riverside');
    expect(container.querySelector('.nav__live')).toBeNull();
  });

  it('shows a live indicator naming the campaign while a match is live', () => {
    const state = {
      queue: { count: 0, joined: false, players: [] }, lobby: null,
      match: {
        id: 4, state: 'live', campaign: 'no_mercy', teamA: [], teamB: [],
        connect: null, waitingForServer: false,
      },
    };
    const { container } = render(
      <LocationProvider><Nav session={{ kind: 'anonymous' }} state={state} /></LocationProvider>,
    );
    const live = container.querySelector('.nav__live');
    expect(live?.textContent).toContain('No Mercy');
    expect(live?.getAttribute('href')).toBe('/live');
  });
});
