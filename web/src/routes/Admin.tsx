import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { DESKS, PEOPLE_TABS, SETUP_TABS, legacyRedirect, parseAdminPath, ticketUrl } from './admin/adminRoutes';
import { AdminLive } from './admin/AdminLive';
import { AdminTickets } from './admin/AdminTickets';
import { AdminTicket } from './admin/AdminTicket';
import { AdminSettings } from './admin/AdminSettings';
import { AdminAudit } from './admin/AdminAudit';
import { AdminSeasons } from './admin/AdminSeasons';
import { AdminCampaigns } from './admin/AdminCampaigns';
import { PeopleSearch } from './admin/PeopleSearch';
import { NeedsALook } from './admin/NeedsALook';
import { PeopleBans } from './admin/PeopleBans';
import { PlayerFile } from './admin/file/PlayerFile';

/**
 * Desk and section navigation, in the site's tab and chip shapes.
 *
 * Links rather than the Tabs component's buttons, because every screen is a
 * URL now: these can be middle-clicked into a new tab, copied out of the
 * address bar and followed back. preact-iso intercepts the plain click, so
 * the panel is still one page. role="tab" is what they are to a screen
 * reader either way.
 */
function LinkTabs({ items, active, label, stripClass, itemClass, activeClass }: {
  items: readonly { key: string; label: string; path: string }[];
  active: string;
  label: string;
  stripClass: string;
  itemClass: string;
  activeClass: string;
}) {
  return (
    <nav class={stripClass} role="tablist" aria-label={label}>
      {items.map((t) => (
        <a
          key={t.key}
          role="tab"
          href={t.path}
          aria-selected={t.key === active}
          class={t.key === active ? `${itemClass} ${activeClass}` : itemClass}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}

const NoSuchPage = () => <Panel><Empty>No such page in the panel.</Empty></Panel>;

/**
 * The staff panel: three desks, and the URL says which screen you are on.
 *
 * The tab state used to live in component memory, so nobody could link
 * anyone to what they were looking at and the back button left the panel.
 * Every screen is a path now, and the shell is only a switch over it.
 *
 * Setup holds today's screens unchanged; its own plan regroups them and adds
 * the Servers and Staff sections, so nothing here is its final shape.
 *
 * The server enforces every route behind this. The guard here only spares
 * somebody a page of refusals.
 */
export function Admin({ session }: { session: Session }) {
  const { path, route } = useLocation();
  const isAdmin = session.kind === 'active' && session.me.isAdmin;
  const isStaff = isAdmin || (session.kind === 'active' && session.me.isMod === true);
  const target = isStaff ? legacyRedirect(path, location.search, isAdmin) : null;
  useEffect(() => { if (target) route(target, true); }, [target]);

  if (session.kind === 'loading') return <div class="page page--admin" />;
  if (session.kind !== 'active' || !isStaff) {
    return (
      <div class="page page--list">
        <Panel><Empty>Staff only.</Empty></Panel>
      </div>
    );
  }
  // One frame of nothing while the redirect lands, rather than mounting a
  // screen that is about to be replaced and firing its requests.
  if (target) return <div class="page page--admin" />;

  const me = session.me.steamid;
  const r = parseAdminPath(path, { isAdmin });
  const sections = r.desk === 'people' ? PEOPLE_TABS : r.desk === 'setup' ? SETUP_TABS : [];
  // A file belongs under Players and a ticket under Tickets, so the strip
  // keeps a highlight while you are inside one.
  const activeSection = r.section === 'file' ? 'search' : r.section === 'ticket' ? 'tickets' : r.section;

  return (
    <div class="page page--admin">
      <PageHeader eyebrow="Riverside" title={isAdmin ? 'Admin' : 'Moderation'} />
      {isAdmin && (
        <LinkTabs items={DESKS} active={r.desk} label="Desks"
          stripClass="tabs" itemClass="tabs__tab" activeClass="is-active" />
      )}
      {sections.length > 0 && (
        <LinkTabs items={sections} active={activeSection} label={`${r.desk} sections`}
          stripClass="admin-sections" itemClass="chip" activeClass="is-on" />
      )}
      <div class="admin-body">
        {r.desk === 'live' && <AdminLive />}
        {r.desk === 'people' && r.section === 'search' && <PeopleSearch />}
        {r.desk === 'people' && r.section === 'file' && <PlayerFile steamid={r.param!} me={me} />}
        {r.desk === 'people' && r.section === 'review' && <NeedsALook isAdmin={isAdmin} />}
        {r.desk === 'people' && r.section === 'bans' && <PeopleBans />}
        {r.desk === 'people' && r.section === 'tickets' && <AdminTickets onOpen={(id) => route(ticketUrl(id))} />}
        {r.desk === 'people' && r.section === 'ticket' && (
          <AdminTicket
            id={Number(r.param)}
            onBack={() => route('/admin/people/tickets')}
            onOpen={(id) => route(ticketUrl(id))}
          />
        )}
        {r.desk === 'setup' && r.section === 'campaigns' && <AdminCampaigns />}
        {r.desk === 'setup' && r.section === 'seasons' && <AdminSeasons />}
        {r.desk === 'setup' && r.section === 'settings' && <AdminSettings />}
        {r.desk === 'setup' && r.section === 'audit' && <AdminAudit />}
        {/* A desk that does not exist, or a section of one that does not.
            Either way the panel says so rather than showing an empty page. */}
        {r.section === 'unknown' && <NoSuchPage />}
      </div>
    </div>
  );
}
