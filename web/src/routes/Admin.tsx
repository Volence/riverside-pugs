import { useState } from 'preact/hooks';
import { Empty, Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { AdminPlayers } from './admin/AdminPlayers';
import { AdminMatches } from './admin/AdminMatches';
import { AdminTickets, ticketFromUrl } from './admin/AdminTickets';
import { AdminSettings } from './admin/AdminSettings';
import { AdminAudit } from './admin/AdminAudit';
import { AdminSeasons } from './admin/AdminSeasons';
import { AdminIntegrity } from './admin/AdminIntegrity';
import { AdminCampaigns } from './admin/AdminCampaigns';

const TABS = [
  { key: 'players', label: 'Players' },
  { key: 'matches', label: 'Matches' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'integrity', label: 'Integrity' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'seasons', label: 'Seasons' },
  { key: 'settings', label: 'Settings' },
  { key: 'audit', label: 'Audit' },
];

/** The staff panel. The server enforces every route; this guard only spares
 *  someone a page of 403s. A moderator gets the Tickets tab and nothing else. */
export function Admin({ session }: { session: Session }) {
  const isAdmin = session.kind === 'active' && session.me.isAdmin;
  const isStaff = isAdmin || (session.kind === 'active' && session.me.isMod === true);
  const [tab, setTab] = useState(() => (ticketFromUrl() !== null ? 'tickets' : 'players'));
  if (session.kind === 'loading') return <div class="page page--admin" />;
  if (session.kind !== 'active' || !isStaff) {
    return (
      <div class="page page--list">
        <Panel><Empty>Staff only.</Empty></Panel>
      </div>
    );
  }
  const tabs = isAdmin ? TABS : TABS.filter((t) => t.key === 'tickets');
  const active = isAdmin ? tab : 'tickets';
  return (
    <div class="page page--admin">
      <PageHeader eyebrow="Riverside" title={isAdmin ? 'Admin' : 'Moderation'} />
      <Tabs tabs={tabs} active={active} onSelect={setTab} />
      <div class="admin-body">
        {active === 'players' && <AdminPlayers me={session.me.steamid} />}
        {active === 'matches' && <AdminMatches />}
        {active === 'tickets' && <AdminTickets />}
        {active === 'integrity' && <AdminIntegrity />}
        {active === 'campaigns' && <AdminCampaigns />}
        {active === 'seasons' && <AdminSeasons />}
        {active === 'settings' && <AdminSettings />}
        {active === 'audit' && <AdminAudit />}
      </div>
    </div>
  );
}
