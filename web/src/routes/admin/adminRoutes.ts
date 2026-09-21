/**
 * Where the panel is, as a URL rather than as component state.
 *
 * The tabs used to live in useState, so an admin could not link anybody to
 * what they were looking at and the back button left the panel. Everything
 * here is a pure function of the path, which is what makes it testable
 * without rendering anything and what keeps the shell free of parsing.
 *
 * Live and Setup are named here and built by their own plans. Their entries
 * exist so the shell has three desks from the start and so nothing has to be
 * renamed when they arrive.
 */
export type Desk = 'live' | 'people' | 'setup';

export interface AdminRoute {
  desk: Desk;
  section: string;
  /** A SteamID on a file, the id on a ticket, otherwise null. */
  param: string | null;
}

export const DESKS: { key: Desk; label: string; path: string }[] = [
  { key: 'live', label: 'Live', path: '/admin/live' },
  { key: 'people', label: 'People', path: '/admin/people' },
  { key: 'setup', label: 'Setup', path: '/admin/setup' },
];

export const PEOPLE_TABS: { key: string; label: string; path: string }[] = [
  { key: 'search', label: 'Players', path: '/admin/people' },
  { key: 'review', label: 'Needs a look', path: '/admin/people/review' },
  { key: 'bans', label: 'Bans', path: '/admin/people/bans' },
  { key: 'tickets', label: 'Tickets', path: '/admin/people/tickets' },
];

/** Setup holds what the old flat tabs held, until the Setup plan regroups it
 *  and adds Servers and Staff. */
export const SETUP_TABS: { key: string; label: string; path: string }[] = [
  { key: 'campaigns', label: 'Campaigns', path: '/admin/setup/campaigns' },
  { key: 'seasons', label: 'Seasons', path: '/admin/setup/seasons' },
  { key: 'settings', label: 'Settings', path: '/admin/setup/settings' },
  { key: 'audit', label: 'Audit', path: '/admin/setup/audit' },
];

export const landingFor = (isAdmin: boolean): string => (isAdmin ? '/admin/live' : '/admin/people');
export const fileUrl = (steamid: string): string => `/admin/people/${encodeURIComponent(steamid)}`;
export const ticketUrl = (id: number | string): string => `/admin/people/tickets/${id}`;

const STEAMID = /^\d{17}$/;

export function parseAdminPath(path: string, opts: { isAdmin: boolean }): AdminRoute {
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const desk = parts[1] ?? '';
  const a = parts[2] ?? '';
  const b = parts[3] ?? '';

  const people = (): AdminRoute => {
    if (a === '') return { desk: 'people', section: 'search', param: null };
    if (a === 'review') return { desk: 'people', section: 'review', param: null };
    if (a === 'bans') return { desk: 'people', section: 'bans', param: null };
    if (a === 'tickets') {
      return b === ''
        ? { desk: 'people', section: 'tickets', param: null }
        : { desk: 'people', section: 'ticket', param: b };
    }
    if (STEAMID.test(a)) return { desk: 'people', section: 'file', param: a };
    return { desk: 'people', section: 'unknown', param: null };
  };

  // A moderator has one desk. Anything else lands on it rather than on a
  // screen every call inside would be refused on anyway.
  if (!opts.isAdmin) return desk === 'people' ? people() : { desk: 'people', section: 'search', param: null };
  if (desk === 'people') return people();
  if (desk === 'setup') return { desk: 'setup', section: a === '' ? 'settings' : a, param: null };
  return { desk: 'live', section: 'board', param: null };
}

/**
 * Where a URL should be sent instead of rendered.
 *
 * `/admin?ticket=12` is what every admin feed post from before this change
 * links to, and those messages are permanent, so the redirect is too.
 */
export function legacyRedirect(path: string, search: string, isAdmin: boolean): string | null {
  const bare = path === '/admin' || path === '/admin/';
  if (bare) {
    const ticket = new URLSearchParams(search).get('ticket');
    if (ticket !== null && /^\d+$/.test(ticket)) return ticketUrl(ticket);
    return landingFor(isAdmin);
  }
  if (!isAdmin && !path.startsWith('/admin/people')) return '/admin/people';
  return null;
}
