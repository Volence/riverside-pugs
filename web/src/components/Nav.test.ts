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
