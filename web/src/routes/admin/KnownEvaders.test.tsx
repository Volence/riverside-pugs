import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { KnownEvader } from '../../api';

const { mockPeople } = vi.hoisted(() => ({
  mockPeople: { evaders: vi.fn(), removeFromPerson: vi.fn(), closePerson: vi.fn(), banSamePerson: vi.fn(), createEvader: vi.fn() },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, peopleApi: { ...actual.peopleApi, ...mockPeople } };
});

const { KnownEvaders } = await import('./KnownEvaders');

const person: KnownEvader = {
  id: 1, label: 'dethisa', note: 'five accounts', createdAt: '2026-10-17T00:00:00.000Z', createdByName: 'system',
  steam: [{ steamid: '76561198129925325', name: 'nepmir', banned: true, held: false, lastSeen: null, how: 'seed' }],
  discord: [{ id: '286250932470153217', how: 'seed' }],
  connections: [{ ipHash: 'abcdef0123456789', steamid: '76561198129925325', country: 'GB', asOrg: 'DATACAMP-LIMITED', vpn: true, lastSeen: '2026-10-16T00:00:00.000Z' }],
  medians: [{ cls: 'hunter claw', person: 12, population: 9 }],
  alerts: [{
    steamid: '76561198000000002', name: 'fresh', level: 'alert', distance: 0.21, threshold: 0.25, rank: 2,
    signs: [], matchId: 900, createdAt: '2026-10-17T21:00:00.000Z', banned: false,
  }],
};

beforeEach(() => {
  for (const f of Object.values(mockPeople)) f.mockReset();
  mockPeople.evaders.mockResolvedValue({ people: [person] });
});
afterEach(() => { cleanup(); });

describe('KnownEvaders', () => {
  it('shows one card per person with accounts, Discords, tagged connections and medians', async () => {
    render(<KnownEvaders isAdmin={false} />);
    expect(await screen.findByText('nepmir')).toBeTruthy();
    // The label heads the card and the medians column.
    expect(screen.getAllByText('dethisa').length).toBe(2);
    expect(screen.getByText('286250932470153217')).toBeTruthy();
    expect(screen.getByText(/DATACAMP-LIMITED/)).toBeTruthy();
    expect(screen.getByText('VPN or hosting')).toBeTruthy();
    expect(screen.getByText('hunter claw')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove from person' })).toBeTruthy();
  });

  it('offers Ban as same person on an alert to admins only', async () => {
    render(<KnownEvaders isAdmin={false} />);
    await screen.findByText('nepmir');
    expect(screen.queryByRole('button', { name: 'Ban as same person' })).toBeNull();
    cleanup();
    render(<KnownEvaders isAdmin />);
    await screen.findByText('nepmir');
    expect(screen.getByRole('button', { name: 'Ban as same person' })).toBeTruthy();
  });
});
