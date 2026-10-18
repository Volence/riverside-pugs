import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { KnownEvader } from '../../api';

const { mockPeople, mockConfirm } = vi.hoisted(() => ({
  mockPeople: {
    evaders: vi.fn(), removeFromPerson: vi.fn(), closePerson: vi.fn(), banSamePerson: vi.fn(), createEvader: vi.fn(),
    dismissFingerprint: vi.fn(),
  },
  mockConfirm: vi.fn(),
}));

vi.mock('../../components/Confirm', () => ({ confirm: mockConfirm }));

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
  for (const f of [...Object.values(mockPeople), mockConfirm]) f.mockReset();
  mockConfirm.mockResolvedValue(true);
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

  it('offers "Not them" on each alert to moderators, confirms, and calls the API', async () => {
    mockPeople.dismissFingerprint.mockResolvedValue({ ok: true });
    render(<KnownEvaders isAdmin={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not them' }));
    await waitFor(() => expect(mockPeople.dismissFingerprint).toHaveBeenCalledWith(1, '76561198000000002'));
    expect(mockConfirm.mock.calls[0][0].title).toBe('fresh is not dethisa?');
    expect(mockConfirm.mock.calls[0][0].confirmLabel).toBe('Not them');
  });

  it('a dismissed alert shows so, with no Not them button (an admin can still ban as same person)', async () => {
    mockPeople.evaders.mockResolvedValue({ people: [{ ...person, alerts: [{ ...person.alerts[0], dismissed: true }] }] });
    render(<KnownEvaders isAdmin />);
    expect(await screen.findByText('not them')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Not them' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ban as same person' })).toBeTruthy();
  });

  it('a cancelled confirm calls nothing', async () => {
    mockConfirm.mockResolvedValue(false);
    render(<KnownEvaders isAdmin={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not them' }));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockPeople.dismissFingerprint).not.toHaveBeenCalled();
  });

  it('removes a Discord member through the same confirm', async () => {
    mockPeople.removeFromPerson.mockResolvedValue({ ok: true });
    render(<KnownEvaders isAdmin={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Discord' }));
    await waitFor(() => expect(mockPeople.removeFromPerson).toHaveBeenCalledWith(1, 'discord', '286250932470153217'));
    expect(mockConfirm.mock.calls[0][0].title).toBe('Take Discord 286250932470153217 off dethisa?');
  });
});
