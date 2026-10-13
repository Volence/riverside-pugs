/** The competitive section's list pages, in tab order. The nav shows the
 *  section as one Compete item; this strip, at the top of each list page,
 *  moves between them. Each tab is a real link to its route, so deep links,
 *  Discord links and the back button all keep working. */
import type { Session } from '../hooks/useLiveState';

export type CompeteTab = 'scrims' | 'bookings' | 'teams' | 'events';

/** [tab, list page, label, prefix of its detail pages]. */
const TABS: readonly (readonly [CompeteTab, string, string, string])[] = [
  ['scrims', '/scrims', 'Scrims', '/scrim/'],
  ['bookings', '/bookings', 'Bookings', '/booking/'],
  ['teams', '/teams', 'Teams', '/team/'],
  ['events', '/events', 'Events', '/event/'],
];

/** Which tab a path belongs to, or null outside the section. Detail pages
 *  count as their list's tab: /team/rats and /team/join/:token are Teams,
 *  /booking/7 is Bookings, and an event's page, draft room and match rooms
 *  are Events. */
export function competeTabFor(path: string): CompeteTab | null {
  for (const [key, href, , detail] of TABS) {
    if (path === href || path.startsWith(detail)) return key;
  }
  return null;
}

/** Scrims shows only when /api/me says the scrims switch lets this viewer
 *  in (`scrims`), so it stays hidden from signed-out visitors too; the page
 *  itself still answers anyone who follows a link to it. */
export function CompeteTabs({ active, session }: { active: CompeteTab; session: Session }) {
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  const tabs = me?.scrims ? TABS : TABS.filter(([key]) => key !== 'scrims');
  return (
    <nav class="tabs competetabs" aria-label="Compete">
      {tabs.map(([key, href, label]) => (
        <a
          key={key}
          href={href}
          class={`tabs__tab${key === active ? ' is-active' : ''}`}
          aria-current={key === active ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
