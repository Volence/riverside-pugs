import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminPlayerRow } from '../api';

const { mockPeople } = vi.hoisted(() => ({
  mockPeople: { people: vi.fn(), file: vi.fn(), review: vi.fn(), bans: vi.fn(), note: vi.fn(), lookedAt: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, peopleApi: mockPeople };
});

const { PeopleSearch } = await import('./admin/PeopleSearch');

const row: AdminPlayerRow = {
  steamid: '76561199000000001', name: 'griefer', avatar: null, status: 'active', isAdmin: false,
  isMod: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 2,
};

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(mockPeople)) fn.mockReset();
  mockPeople.people.mockResolvedValue({ players: [row] });
});

describe('People search', () => {
  it('lists players and links each one to their file', async () => {
    render(<PeopleSearch />);
    const link = await screen.findByRole('link', { name: 'griefer' });
    expect(link.getAttribute('href')).toBe('/admin/people/76561199000000001');
    expect(screen.getByText('2')).toBeTruthy();
    expect(mockPeople.people).toHaveBeenCalledWith('', expect.anything());
  });

  it('searches on submit', async () => {
    render(<PeopleSearch />);
    await screen.findByRole('link', { name: 'griefer' });
    fireEvent.input(screen.getByLabelText('Search players'), { target: { value: ' walls ' } });
    fireEvent.submit(screen.getByLabelText('Search players').closest('form')!);
    await waitFor(() => expect(mockPeople.people).toHaveBeenCalledWith('walls', expect.anything()));
  });

  it('says so when nobody matches', async () => {
    mockPeople.people.mockResolvedValue({ players: [] });
    render(<PeopleSearch />);
    expect(await screen.findByText('No players match.')).toBeTruthy();
  });
});
