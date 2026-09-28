import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { AdminOverview } from '../../api';
import { AdminServersPanel } from './MatchPanels';

afterEach(cleanup);

const server = (over: Partial<AdminOverview['servers'][number]> = {}): AdminOverview['servers'][number] => ({
  id: 4, name: 'Riverside #4', host: '66.59.208.5', port: 27016, status: 'idle', enabled: 1,
  tvPort: null, tvPassword: null, tvEnabled: 0, restartAfterMatch: 1, practice: null, ...over,
});

describe('AdminServersPanel and practice leases', () => {
  it('shows a leased box as in use for practice, with the owner linking to the lease, not as idle', () => {
    render(<AdminServersPanel busy={false} run={async () => {}}
      servers={[server({ practice: { leaseId: 7, kind: 'park', ownerName: 'mayhem', ending: false } })]} />);
    expect(screen.getByText('practice (park)')).toBeTruthy();
    expect(screen.queryByText('idle')).toBeNull();
    expect(screen.getByRole('link', { name: 'mayhem' }).getAttribute('href')).toBe('/practice/7');
  });

  it('says closing while the lease winds down, and offers no Set idle meanwhile', () => {
    render(<AdminServersPanel busy={false} run={async () => {}}
      servers={[server({ status: 'offline', practice: { leaseId: 7, kind: 'drill', ownerName: 'mayhem', ending: true } })]} />);
    expect(screen.getByText('practice, closing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set idle' })).toBeNull();
  });

  it('an unleased box shows its status as before', () => {
    render(<AdminServersPanel busy={false} run={async () => {}} servers={[server()]} />);
    expect(screen.getByText('idle')).toBeTruthy();
  });
});
