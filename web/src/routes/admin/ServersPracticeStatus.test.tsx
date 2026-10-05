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
  it('shows a drill server as in use for practice, with its owner linking to the lease, not as idle', () => {
    render(<AdminServersPanel busy={false} run={async () => {}}
      servers={[server({ practice: { leaseId: 7, kind: 'drill', ownerName: 'mayhem', ending: false } })]} />);
    expect(screen.getByText('practice (drill)')).toBeTruthy();
    expect(screen.queryByText('idle')).toBeNull();
    expect(screen.getByRole('link', { name: 'mayhem' }).getAttribute('href')).toBe('/practice/7');
  });

  it('shows a park as practice, with who started it and no owner link', () => {
    render(<AdminServersPanel busy={false} run={async () => {}}
      servers={[server({ practice: { leaseId: 7, kind: 'park', ownerName: 'mayhem', ending: false } })]} />);
    expect(screen.getByText('practice (park)')).toBeTruthy();
    expect(screen.getByText('started by mayhem')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'mayhem' })).toBeNull();
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

describe('AdminServersPanel pick order', () => {
  const two = [server({ id: 1, name: 'Dallas' }), server({ id: 4, name: 'Riverside #4' })];

  it('numbers rows in pick order and only offers the moves that exist', () => {
    render(<AdminServersPanel busy={false} run={async () => {}} servers={two} />);
    expect((screen.getByRole('button', { name: 'Move Dallas up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move Dallas down' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Move Riverside #4 down' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a moderator sees the order but cannot change it', () => {
    render(<AdminServersPanel busy={false} run={async () => {}} servers={two} canManage={false} />);
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });
});
