import { describe, it, expect } from 'vitest';
import { fileUrl, landingFor, legacyRedirect, parseAdminPath, ticketUrl } from './adminRoutes';

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

  it('leaves room for the other two desks', () => {
    expect(parseAdminPath('/admin/live', asAdmin)).toEqual({ desk: 'live', section: 'board', param: null });
    expect(parseAdminPath('/admin/setup', asAdmin)).toEqual({ desk: 'setup', section: 'settings', param: null });
    expect(parseAdminPath('/admin/setup/audit', asAdmin)).toEqual({ desk: 'setup', section: 'audit', param: null });
    expect(parseAdminPath('/admin/setup/campaigns', asAdmin)).toEqual({ desk: 'setup', section: 'campaigns', param: null });
  });

  it('gives a moderator the People desk whatever the URL says', () => {
    expect(parseAdminPath('/admin/live', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/setup/settings', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/people/review', asMod)).toEqual({ desk: 'people', section: 'review', param: null });
  });

  it('sends the old links and the bare /admin somewhere real', () => {
    expect(legacyRedirect('/admin', '?ticket=12', true)).toBe('/admin/people/tickets/12');
    expect(legacyRedirect('/admin', '', true)).toBe('/admin/live');
    expect(legacyRedirect('/admin', '', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin/live', '', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin/people/review', '', false)).toBeNull();
    expect(legacyRedirect('/admin/live', '', true)).toBeNull();
  });

  it('builds the links everything else points at', () => {
    expect(landingFor(true)).toBe('/admin/live');
    expect(landingFor(false)).toBe('/admin/people');
    expect(fileUrl('76561199000000001')).toBe('/admin/people/76561199000000001');
    expect(ticketUrl(12)).toBe('/admin/people/tickets/12');
  });
});
