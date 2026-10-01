/**
 * A tab opened before a web deploy still runs the old bundle, whose lazy page
 * chunks the deploy deleted. Opening one of those pages then fails to import,
 * and the router keeps showing the page you came from (seen 2026-10-01: Scrims
 * in the nav, the Bookings page under it). Vite reports the failed import as
 * `vite:preloadError`; reloading fetches the new index and its new chunks.
 *
 * At most one reload per RELOAD_GAP_MS, so a chunk that is really missing (a
 * broken deploy) cannot loop the tab; the second failure just stays put.
 */
export const RELOAD_GAP_MS = 10_000;
const KEY = 'stale-bundle-reload-at';

export function installStaleBundleReload(win: Window = window): void {
  win.addEventListener('vite:preloadError', (event) => {
    let last = 0;
    try {
      last = Number(win.sessionStorage.getItem(KEY)) || 0;
    } catch {
      // Storage blocked: still reload, the gap just cannot be remembered.
    }
    const now = Date.now();
    if (now - last < RELOAD_GAP_MS) return;
    try {
      win.sessionStorage.setItem(KEY, String(now));
    } catch {
      // As above.
    }
    event.preventDefault();
    win.location.reload();
  });
}
