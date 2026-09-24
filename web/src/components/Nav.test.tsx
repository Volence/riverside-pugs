import { describe, it, expect } from 'vitest';
import { NAV_LINKS } from './Nav';

describe('NAV_LINKS', () => {
  it('offers the crosshair maker as an in-site route', () => {
    // It was /crosshair.html with target=_blank, a standalone document with
    // its own palette and no way back. Now a route, so it keeps the header.
    const link = NAV_LINKS.find(([href]) => href === '/crosshair');
    expect(link).toBeTruthy();
    expect(link![2]).toBeUndefined();
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

  it('offers Custom alongside Campaigns, at its own path', () => {
    const paths = NAV_LINKS.map(([href]) => href);
    expect(paths).toContain('/maps');
    expect(paths).toContain('/custom-campaigns');
    // /maps is stats about maps played; this is how to install one. Merging the
    // two would break bookmarks and muddle both jobs.
    expect(NAV_LINKS.find(([href]) => href === '/custom-campaigns')![1]).toBe('Custom');
  });
});

import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { afterEach, vi } from 'vitest';
import { Nav } from './Nav';
import { api } from '../api';

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
  // There was no way to sign out at all: the only exit was clearing cookies.
  it('offers Sign out to a signed-in player, ends the session, and refreshes', async () => {
    const logout = vi.spyOn(api, 'logout').mockResolvedValue({ ok: true });
    const onSignedOut = vi.fn();
    const me = { steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false };
    render(
      <LocationProvider><Nav session={{ kind: 'active', me }} state={null} onSignedOut={onSignedOut} /></LocationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
    expect(logout).toHaveBeenCalledTimes(1);
    logout.mockRestore();
  });

  // The ban list is a People screen inside the panel. It had a nav entry of its
  // own for a while, which only duplicated a screen the panel already owns.
  it('keeps Bans out of the nav and sends moderators in through the panel', () => {
    const mod = { steamid: '1', name: 'mod', avatar: null, status: 'active', isAdmin: false, isMod: true };
    const { unmount } = render(
      <LocationProvider><Nav session={{ kind: 'active', me: mod }} state={null} /></LocationProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Bans' })).toBeNull();
    expect((screen.getByRole('link', { name: 'Moderation' }) as HTMLAnchorElement).getAttribute('href'))
      .toBe('/admin');
    unmount();
    const player = { steamid: '2', name: 'alice', avatar: null, status: 'active', isAdmin: false };
    render(<LocationProvider><Nav session={{ kind: 'active', me: player }} state={null} /></LocationProvider>);
    expect(screen.queryByRole('link', { name: 'Bans' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Moderation' })).toBeNull();
  });

  it('offers it to a pending or banned account too, and to nobody signed out', () => {
    const me = { steamid: '1', name: 'alice', avatar: null, status: 'banned', isAdmin: false };
    const { unmount } = render(
      <LocationProvider><Nav session={{ kind: 'pending', me }} state={null} /></LocationProvider>,
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    unmount();
    render(<LocationProvider><Nav session={{ kind: 'anonymous' }} state={null} /></LocationProvider>);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
