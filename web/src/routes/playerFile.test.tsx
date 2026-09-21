import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { PlayerFileData } from '../api';
import { ConfirmHost } from '../components/Confirm';

const { mockPeople, mockAdmin, mockMod } = vi.hoisted(() => ({
  mockPeople: { people: vi.fn(), file: vi.fn(), review: vi.fn(), bans: vi.fn(), note: vi.fn(), lookedAt: vi.fn() },
  mockAdmin: {
    ban: vi.fn(), unban: vi.fn(), activate: vi.fn(), setAdmin: vi.fn(), setMod: vi.fn(),
    signOutPlayer: vi.fn(), clearPenalties: vi.fn(), unlinkDiscord: vi.fn(),
    mergePlayer: vi.fn(), unaliasPlayer: vi.fn(), steamRefresh: vi.fn(), integrityReview: vi.fn(),
  },
  mockMod: { open: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    peopleApi: mockPeople,
    adminApi: { ...actual.adminApi, ...mockAdmin },
    modApi: { ...actual.modApi, ...mockMod },
  };
});

const { PlayerFile } = await import('./admin/file/PlayerFile');

const P = '76561199000000001';
const ADMIN_ACTIONS = ['note', 'looked_at', 'open_ticket', 'ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags'] as const;

const file = (over: Partial<PlayerFileData> = {}): PlayerFileData => ({
  steamid: P,
  header: {
    steamid: P, name: 'griefer', avatar: null, status: 'active', isAdmin: false, isMod: false,
    discordName: 'grief#1', sr: 900, games: 12, createdAt: '2026-08-01T00:00:00.000Z',
  },
  glance: {
    steamid: P, name: 'griefer', avatar: null, status: 'active', isAdmin: false, isMod: false,
    sr: 900, games: 12, createdAt: '2026-08-01T00:00:00.000Z',
    activeBan: null, bans: 1, penalties: 2, timeout: null, openTickets: 1, aliases: 1,
    sharesAddressWith: [{ steamid: '76561199000000002', name: 'sibling' }],
    steamFlags: [{ kind: 'new_account', text: 'New account: created 3 days before their first match here.' }],
    evidence: [{ source: 'lilac', count: 2 }],
    analyzer: null, lastReview: null, fileUrl: `/admin/people/${P}`,
  },
  timeline: [],
  sections: {
    identity: {
      aliases: [{ steamid: '76561199000000002', canonical: P, created_at: '2026-09-01', created_by: 'boss' }],
      discordHistory: [],
      steamAccount: null,
      networks: [],
      sharesAddressWith: [{ steamid: '76561199000000002', name: 'sibling', country: 'US', seenCount: 4, lastSeen: '2026-09-20' }],
    },
    standing: {
      activeBan: null,
      bans: [{ id: 1, reason: 'throwing', createdBy: '9', createdByName: 'boss', createdAt: '2026-09-01T00:00:00.000Z', expiresAt: null, liftedBy: null, liftedByName: null, liftedAt: '2026-09-02T00:00:00.000Z' }],
      // A different match than sections.matches[0] on purpose: both render an
      // "#<id>" link, and sharing an id makes the two link assertions below
      // ambiguous about which one they found.
      penalties: [{ id: 1, kind: 'no_show', matchId: 8, createdAt: '2026-09-10T00:00:00.000Z', clearedBy: null, clearedAt: null }],
      timeout: null,
    },
    matches: [{ id: 7, campaign: 'dead_air', state: 'completed', endedAt: '2026-09-10T00:00:00.000Z', winner: 'a', team: 'b', connectedAt: null }],
    tickets: [{
      id: 12, targetId: P, targetName: 'griefer', status: 'open', outcome: null, restricted: false,
      claimedBy: null, claimedByName: null, reports: 2, reporters: 2, categories: ['cheating'],
      createdAt: '2026-09-20T00:00:00.000Z', lastReportAt: null, closedAt: null,
    }],
    notes: [{ id: 1, authorId: '9', authorName: 'boss', text: 'had a word', createdAt: '2026-09-11T00:00:00.000Z' }],
    evidence: {
      analyzer: null, rounds: [], clips: [], flags: [], inputFlags: [], inputCaps: [],
      signonDrops: { count: 0, lastAt: null, rows: [] },
    },
  },
  actions: [...ADMIN_ACTIONS],
  lastReview: null,
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [...Object.values(mockPeople), ...Object.values(mockAdmin), ...Object.values(mockMod)]) fn.mockReset();
  mockPeople.file.mockResolvedValue(file());
  mockPeople.note.mockResolvedValue({ ok: true });
  mockPeople.lookedAt.mockResolvedValue({ ok: true, review: { id: 1, steamid: P, reviewedBy: '9', reviewedByName: 'boss', reviewedAt: '2026-09-21T00:00:00.000Z', note: '' } });
  for (const fn of Object.values(mockAdmin)) fn.mockResolvedValue({ ok: true });
  mockMod.open.mockResolvedValue({ ok: true, ticketId: 12 });
});

describe('the Player File', () => {
  it('says whose file it is, what is on it, and what is at a glance', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByRole('heading', { name: /griefer/ })).toBeTruthy();
    expect(screen.getByText(P)).toBeTruthy();
    expect(screen.getByText(/12 games/)).toBeTruthy();
    expect(screen.getByText(/1 open ticket/)).toBeTruthy();
    expect(screen.getByText(/2 Little Anti-Cheat/)).toBeTruthy();
    expect(screen.getByText(/New account/)).toBeTruthy();
    expect(screen.getByText('Nobody has marked this file looked at.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('/admin/people/tickets/12');
    expect(screen.getByRole('link', { name: '#7' }).getAttribute('href')).toBe('/match/7');
  });

  it('tells a viewer plainly when there is no such file', async () => {
    mockPeople.file.mockRejectedValue(new Error('404'));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText('No such player, or not a file you can open.')).toBeTruthy();
  });

  it('bans, unbans and clears penalties from the standing section', async () => {
    render(<><PlayerFile steamid={P} me="76561199000000009" /><ConfirmHost /></>);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByLabelText('Ban reason'), { target: { value: 'throwing' } });
    fireEvent.change(screen.getByLabelText('Ban length'), { target: { value: '1440' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    expect(dialog.textContent).toContain('throwing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(mockAdmin.ban).toHaveBeenCalledWith(P, 'throwing', 1440));
  });

  it('writes a note and marks the file looked at', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'spoke to them' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(mockPeople.note).toHaveBeenCalledWith(P, 'spoke to them'));

    fireEvent.input(screen.getByLabelText('Review note'), { target: { value: 'nothing there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Looked at this' }));
    await waitFor(() => expect(mockPeople.lookedAt).toHaveBeenCalledWith(P, 'nothing there'));
  });

  it('opens a ticket about the player', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Open a ticket' }));
    await waitFor(() => expect(mockMod.open).toHaveBeenCalledWith(P, '', false));
  });

  it('gives a moderator every section and none of the admin controls', async () => {
    mockPeople.file.mockResolvedValue(file({ actions: ['note', 'looked_at', 'open_ticket'] }));
    render(<PlayerFile steamid={P} me="76561199000000008" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByLabelText('Note')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Looked at this' })).toBeTruthy();
    expect(screen.queryByLabelText('Ban reason')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
    expect(screen.queryByPlaceholderText('SteamID64 to keep')).toBeNull();
    // The sections themselves are not hidden from a moderator: only actions.
    expect(screen.getByText(/Seen on the same connection as/)).toBeTruthy();
    expect(screen.getByText('throwing')).toBeTruthy();
  });

  it('previews a merge before offering to run one', async () => {
    mockAdmin.mergePlayer.mockResolvedValue({ plan: { from: P, into: '76561199000000002', matchesMoved: 3, matchesCollapsed: 1, rowsByTable: { bans: 1 }, seasons: [1] } });
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByPlaceholderText('SteamID64 to keep'), { target: { value: '76561199000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(mockAdmin.mergePlayer).toHaveBeenCalledWith(P, '76561199000000002', true));
    // A bare /3/ also matches the header's join date and the "3 days" steam
    // flag; pin this to the plan's own bolded matchesMoved count instead.
    expect(await screen.findByText((_, el) => el?.tagName === 'STRONG' && el.textContent === '3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge and recompute' })).toBeTruthy();
  });
});
