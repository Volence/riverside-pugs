import { describe, it, expect } from 'vitest';
import { ADMIN_ROUTE_PATHS, fileUrl, landingFor, legacyRedirect, parseAdminPath, ticketUrl } from './adminRoutes';
import { exec } from 'preact-iso/router';

const asAdmin = { isAdmin: true };
const asMod = { isAdmin: false };

describe('the panel URL parser', () => {
  it('reads every People screen', () => {
    expect(parseAdminPath('/admin/people', asAdmin)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/people/review', asAdmin)).toEqual({ desk: 'people', section: 'review', param: null });
    expect(parseAdminPath('/admin/people/bans', asAdmin)).toEqual({ desk: 'people', section: 'bans', param: null });
    expect(parseAdminPath('/admin/people/tickets', asAdmin)).toEqual({ desk: 'people', section: 'tickets', param: null });
    expect(parseAdminPath('/admin/people/tickets/12', asAdmin)).toEqual({ desk: 'people', section: 'ticket', param: '12' });
    expect(parseAdminPath('/admin/people/76561199000000001', asAdmin))
      .toEqual({ desk: 'people', section: 'file', param: '76561199000000001' });
    expect(parseAdminPath('/admin/people/nonsense', asAdmin)).toEqual({ desk: 'people', section: 'unknown', param: null });
  });

  // Each of these used to render something wrong: a desk nobody asked for,
  // a ticket page fetching NaN, or a URIError that white-screened the site,
  // since a bad escape in the path throws in decodeURIComponent.
  it('says no such page for anything else', () => {
    expect(parseAdminPath('/admin/servers', asAdmin)).toEqual({ desk: 'unknown', section: 'unknown', param: null });
    expect(parseAdminPath('/admin/setup/nonsense', asAdmin)).toEqual({ desk: 'setup', section: 'unknown', param: null });
    expect(parseAdminPath('/admin/people/tickets/abc', asAdmin)).toEqual({ desk: 'people', section: 'unknown', param: null });
    expect(parseAdminPath('/admin/people/%E0%A4%A', asAdmin)).toEqual({ desk: 'people', section: 'unknown', param: null });
  });

  it('leaves room for the other two desks', () => {
    expect(parseAdminPath('/admin/live', asAdmin)).toEqual({ desk: 'live', section: 'board', param: null });
    expect(parseAdminPath('/admin/setup', asAdmin)).toEqual({ desk: 'setup', section: 'settings', param: null });
    expect(parseAdminPath('/admin/setup/audit', asAdmin)).toEqual({ desk: 'setup', section: 'audit', param: null });
    expect(parseAdminPath('/admin/setup/campaigns', asAdmin)).toEqual({ desk: 'setup', section: 'campaigns', param: null });
  });

  it('parses the balance desk', () => {
    expect(parseAdminPath('/admin/balance', asAdmin)).toEqual({ desk: 'balance', section: 'compare', param: null });
    expect(parseAdminPath('/admin/balance/patches', asAdmin)).toEqual({ desk: 'balance', section: 'patches', param: null });
    expect(parseAdminPath('/admin/balance/nope', asAdmin)).toMatchObject({ desk: 'balance', section: 'unknown' });
    expect(parseAdminPath('/admin/balance', { isAdmin: false })).toMatchObject({ desk: 'people' });
  });

  it('redirects the old patches page', () => {
    expect(legacyRedirect('/admin/setup/patches', '', true)).toBe('/admin/balance/patches');
  });

  it('gives a moderator the People desk whatever the URL says', () => {
    expect(parseAdminPath('/admin/live', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/setup/settings', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/people/review', asMod)).toEqual({ desk: 'people', section: 'review', param: null });
  });

  it('sends the old links and the bare /admin somewhere real', () => {
    expect(legacyRedirect('/admin', '?ticket=12', true)).toBe('/admin/people/tickets/12');
    // The board reads ?live= for itself, so the query has to survive the
    // redirect: every low-allowance post in the admin feed is that link.
    expect(legacyRedirect('/admin', '?live=81', true)).toBe('/admin/live?live=81');
    expect(legacyRedirect('/admin', '?live=nonsense', true)).toBe('/admin/live');
    expect(legacyRedirect('/admin', '?live=81', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin', '', true)).toBe('/admin/live');
    expect(legacyRedirect('/admin', '', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin/live', '', false)).toBe('/admin/people');
    // Not a People path, however much it looks like one from the left.
    expect(legacyRedirect('/admin/peoplefoo', '', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin/people', '', false)).toBeNull();
    expect(legacyRedirect('/admin/people/review', '', false)).toBeNull();
    expect(legacyRedirect('/admin/live', '', true)).toBeNull();
  });

  // The bug this pins: one <Route path="/admin"> matches the bare path and
  // nothing under it, so every deep link would have landed on the site's 404
  // with no sign of why.
  it('declares route paths that reach every screen', () => {
    // exec is typed as always returning a match; it returns undefined when
    // the pattern does not fit, which is the whole question here.
    const matched = (url: string) => ADMIN_ROUTE_PATHS.some(
      (p) => (exec(url, p, { path: url, query: {}, params: {} }) as unknown) !== undefined,
    );
    for (const url of [
      '/admin', '/admin/live', '/admin/people', '/admin/people/review', '/admin/people/bans',
      '/admin/people/tickets', '/admin/people/tickets/12', '/admin/people/76561199000000001',
      '/admin/setup', '/admin/setup/settings', '/admin/setup/audit',
      '/admin/balance', '/admin/balance/patches',
    ]) expect(matched(url), url).toBe(true);
    expect(matched('/bans')).toBe(false);
  });

  it('builds the links everything else points at', () => {
    expect(landingFor(true)).toBe('/admin/live');
    expect(landingFor(false)).toBe('/admin/people');
    expect(fileUrl('76561199000000001')).toBe('/admin/people/76561199000000001');
    expect(ticketUrl(12)).toBe('/admin/people/tickets/12');
  });
});
