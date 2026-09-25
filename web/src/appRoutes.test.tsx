import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { AppRoutes } from './AppRoutes';

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });

/** The site's real route table, mounted at a URL. Signed out, so nothing
 *  behind a session fetches anything. */
const open = (path: string) => {
  history.replaceState(null, '', path);
  return render(
    <LocationProvider>
      <AppRoutes session={{ kind: 'anonymous' }} state={null} refresh={() => {}} />
    </LocationProvider>,
  );
};

describe('the site route table', () => {
  // The ban list moved into the panel. Asserted against the real table rather
  // than against the Redirect component, so losing the route fails here.
  it('sends the old ban list URL into the panel', async () => {
    open('/bans');
    await waitFor(() => expect(location.pathname).toBe('/admin/people/bans'));
  });

  it('mounts the panel below /admin, not the 404', async () => {
    open('/admin/people/bans');
    expect(await screen.findByText('Staff only.')).toBeTruthy();
  });

  it('still has a 404 for a path that is not a route', async () => {
    open('/not-a-page');
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
  it('mounts the community page and an entry page', async () => {
    // Nothing behind them is running here: every fetch is a 404.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const first = open('/community');
    expect(await screen.findByText('Shared HUDs and crosshairs')).toBeTruthy();
    first.unmount();
    open('/community/5');
    expect(await screen.findByText('This entry was removed.')).toBeTruthy();
  });

  it.each([
    ['/hud', 'HUD editor'],
    ['/crosshair', 'Crosshair'],
    ['/community', 'Community'],
    ['/community/5', 'Community'],
  ])('keeps %s working, under the HUD tab strip with %s current', async (path, tab) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    open(path);
    const strip = await screen.findByRole('navigation', { name: 'HUD tools' }, { timeout: 5000 });
    const current = [...strip.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent);
    expect(current).toEqual([tab]);
  }, 15000);
});
