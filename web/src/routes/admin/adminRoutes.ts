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
export type Desk = 'live' | 'people' | 'setup' | 'balance';

export interface AdminRoute {
  /** 'unknown' is a path that names no desk at all, such as /admin/servers. */
  desk: Desk | 'unknown';
  /** 'unknown' is a path whose desk exists but whose screen does not. */
  section: string;
  /** A SteamID on a file, the id on a ticket, otherwise null. */
  param: string | null;
}

export const DESKS: { key: Desk; label: string; path: string }[] = [
  { key: 'live', label: 'Live', path: '/admin/live' },
  { key: 'people', label: 'People', path: '/admin/people' },
  { key: 'setup', label: 'Setup', path: '/admin/setup' },
  { key: 'balance', label: 'Balance', path: '/admin/balance' },
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
  { key: 'fleet', label: 'Fleet', path: '/admin/setup/fleet' },
  { key: 'deploy', label: 'Deploy', path: '/admin/setup/deploy' },
  { key: 'seasons', label: 'Seasons', path: '/admin/setup/seasons' },
  { key: 'settings', label: 'Settings', path: '/admin/setup/settings' },
  { key: 'audit', label: 'Audit', path: '/admin/setup/audit' },
];

export const BALANCE_TABS: { key: string; label: string; path: string }[] = [
  { key: 'compare', label: 'Compare', path: '/admin/balance' },
  { key: 'patches', label: 'Patches', path: '/admin/balance/patches' },
  { key: 'knobs', label: 'Knobs', path: '/admin/balance/knobs' },
  { key: 'values', label: 'Values', path: '/admin/balance/values' },
];

/**
 * What main.tsx hands preact-iso for the panel.
 *
 * Two entries, because its matcher takes neither on its own: `/admin` matches
 * the bare path and nothing under it, and `/admin/*` needs a segment after
 * the star to match at all. A deep link with no route lands on the site's
 * 404, which is a hard thing to diagnose from a bookmark that used to work.
 */
export const ADMIN_ROUTE_PATHS: readonly string[] = ['/admin', '/admin/*'];

export const landingFor = (isAdmin: boolean): string => (isAdmin ? '/admin/live' : '/admin/people');
export const fileUrl = (steamid: string): string => `/admin/people/${encodeURIComponent(steamid)}`;
export const ticketUrl = (id: number | string): string => `/admin/people/tickets/${id}`;

const STEAMID = /^\d{17}$/;
const TICKET = /^\d+$/;
const NOWHERE: AdminRoute = { desk: 'unknown', section: 'unknown', param: null };

/** A path segment can hold a malformed escape, and decodeURIComponent throws
 *  a URIError on one. Nothing above this catches it, so an unescaped throw
 *  here white-screens the whole site over a mistyped link. */
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export function parseAdminPath(path: string, opts: { isAdmin: boolean }): AdminRoute {
  const parts = path.split('/').filter(Boolean).map(decode);
  const desk = parts[1] ?? '';
  const a = parts[2] ?? '';
  const b = parts[3] ?? '';

  const people = (): AdminRoute => {
    if (a === '') return { desk: 'people', section: 'search', param: null };
    if (a === 'review') return { desk: 'people', section: 'review', param: null };
    if (a === 'bans') return { desk: 'people', section: 'bans', param: null };
    if (a === 'tickets') {
      if (b === '') return { desk: 'people', section: 'tickets', param: null };
      // The ticket page fetches by id, so a param that is not one is a bad
      // link rather than a page asking the API about NaN.
      return TICKET.test(b) ? { desk: 'people', section: 'ticket', param: b } : { ...NOWHERE, desk: 'people' };
    }
    if (STEAMID.test(a)) return { desk: 'people', section: 'file', param: a };
    return { ...NOWHERE, desk: 'people' };
  };

  // A moderator has one desk. Anything else lands on it rather than on a
  // screen every call inside would be refused on anyway.
  if (!opts.isAdmin) return desk === 'people' ? people() : { desk: 'people', section: 'search', param: null };
  if (desk === 'people') return people();
  if (desk === 'setup') {
    const section = a === '' ? 'settings' : a;
    return SETUP_TABS.some((t) => t.key === section)
      ? { desk: 'setup', section, param: null }
      : { ...NOWHERE, desk: 'setup' };
  }
  if (desk === 'balance') {
    const section = a === '' ? 'compare' : a;
    return BALANCE_TABS.some((t) => t.key === section)
      ? { desk: 'balance', section, param: null }
      : { ...NOWHERE, desk: 'balance' };
  }
  // The bare /admin is redirected to a desk before anything parses it; it is
  // read as Live here so one frame of it cannot say the panel has no page.
  if (desk === 'live' || desk === '') return { desk: 'live', section: 'board', param: null };
  return NOWHERE;
}

/**
 * Where a URL should be sent instead of rendered.
 *
 * `/admin?ticket=12` is what every admin feed post from before this change
 * links to, and those messages are permanent, so the redirect is too.
 */
export function legacyRedirect(path: string, search: string, isAdmin: boolean): string | null {
  if (isAdmin && (path === '/admin/setup/patches' || path === '/admin/setup/patches/')) return '/admin/balance/patches';
  const bare = path === '/admin' || path === '/admin/';
  if (bare) {
    const q = new URLSearchParams(search);
    const ticket = q.get('ticket');
    if (ticket !== null && /^\d+$/.test(ticket)) return ticketUrl(ticket);
    // The board reads ?live= itself, so that one is carried over rather than
    // dropped: it is the whole point of the link the admin feed posts when a
    // dropped player is nearly out of reconnect time.
    const live = q.get('live');
    if (isAdmin && live !== null && /^\d+$/.test(live)) return `/admin/live?live=${live}`;
    return landingFor(isAdmin);
  }
  // The People desk itself or something inside it. A prefix test alone would
  // count /admin/peoplefoo as inside.
  const inPeople = path === '/admin/people' || path.startsWith('/admin/people/');
  if (!isAdmin && !inPeople) return '/admin/people';
  return null;
}
