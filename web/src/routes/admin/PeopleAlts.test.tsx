import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { AltCluster, AltHold } from '../../api';

const { mockPeople } = vi.hoisted(() => ({ mockPeople: { alts: vi.fn(), liftHold: vi.fn(), banFromHold: vi.fn() } }));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, peopleApi: { ...actual.peopleApi, ...mockPeople } };
});

const { PeopleAlts } = await import('./PeopleAlts');

const OLD = '76561198000000001';
const NEW = '76561198000000002';
const HOUSE = '76561198000000003';

const hold: AltHold = {
  id: 7, steamid: NEW, name: 'ne', otherSteamid: OLD, otherName: 'sleepmark', otherBanned: true,
  discordId: '286', discordName: 'dethisa', createdAt: '2026-10-02T15:30:03.256Z',
  resolvedAt: null, resolvedByName: null, resolution: null,
};
const strong: AltCluster = {
  members: [
    { steamid: OLD, name: 'sleepmark', banned: true, held: false, lastSeen: null },
    { steamid: NEW, name: 'ne', banned: false, held: true, lastSeen: null },
  ],
  edges: [{ a: OLD, b: NEW, signal: 'discord', detail: 'Discord dethisa moved', at: '2026-10-02T15:30:03.256Z' }],
  latest: '2026-10-02T15:30:03.256Z', hasOpenHold: true, strong: true,
};
const weak: AltCluster = {
  members: [
    { steamid: OLD, name: 'roomie', banned: false, held: false, lastSeen: null },
    { steamid: HOUSE, name: 'housemate', banned: false, held: false, lastSeen: null },
  ],
  edges: [{ a: OLD, b: HOUSE, signal: 'connection', detail: 'same connection', at: null }],
  latest: null, hasOpenHold: false, strong: false,
};

beforeEach(() => {
  for (const f of Object.values(mockPeople)) f.mockReset();
  mockPeople.alts.mockResolvedValue({ open: [hold], settled: [], clusters: [strong, weak] });
});
afterEach(() => { cleanup(); });

describe('PeopleAlts', () => {
  it('lists the open hold with where the Discord came from', async () => {
    render(<PeopleAlts isAdmin={false} />);
    expect(await screen.findByText('dethisa')).toBeTruthy();
    expect(screen.getAllByText('sleepmark').length).toBeGreaterThan(0);
  });

  it('gives a moderator Lift but not Ban, and an admin both', async () => {
    render(<PeopleAlts isAdmin={false} />);
    await screen.findByText('dethisa');
    expect(screen.getByRole('button', { name: 'Lift hold' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
    cleanup();
    render(<PeopleAlts isAdmin />);
    await screen.findByText('dethisa');
    expect(screen.getByRole('button', { name: 'Ban' })).toBeTruthy();
  });

  it('hides groups tied only by a shared connection until asked', async () => {
    render(<PeopleAlts isAdmin={false} />);
    await screen.findByText('dethisa');
    expect(screen.queryByText('housemate')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Also show 1 group tied only by a shared connection/));
    expect(await screen.findByText('housemate')).toBeTruthy();
  });
});
