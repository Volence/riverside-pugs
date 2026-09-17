import { useState } from 'preact/hooks';
import { Empty, Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { AdminPlayers } from './admin/AdminPlayers';
import { AdminMatches } from './admin/AdminMatches';
import { AdminReports } from './admin/AdminReports';
import { AdminSettings } from './admin/AdminSettings';
import { AdminAudit } from './admin/AdminAudit';

const TABS = [
  { key: 'players', label: 'Players' },
  { key: 'matches', label: 'Matches' },
  { key: 'reports', label: 'Reports' },
  { key: 'settings', label: 'Settings' },
  { key: 'audit', label: 'Audit' },
];

/** The admin panel. The server enforces admin on every route; this guard only
 *  spares a non-admin a page of 403s. */
export function Admin({ session }: { session: Session }) {
  const [tab, setTab] = useState('players');
  if (session.kind === 'loading') return <div class="page page--admin" />;
  if (session.kind !== 'active' || !session.me.isAdmin) {
    return (
      <div class="page page--list">
        <Panel><Empty>Admins only.</Empty></Panel>
      </div>
    );
  }
  return (
    <div class="page page--admin">
      <PageHeader eyebrow="Riverside" title="Admin" />
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      <div class="admin-body">
        {tab === 'players' && <AdminPlayers me={session.me.steamid} />}
        {tab === 'matches' && <AdminMatches />}
        {tab === 'reports' && <AdminReports />}
        {tab === 'settings' && <AdminSettings />}
        {tab === 'audit' && <AdminAudit />}
      </div>
    </div>
  );
}
