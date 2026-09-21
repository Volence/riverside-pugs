import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { AdminPlayerRow, NeedsALookRow, PeopleBan } from '../api';

const { mockPeople, mockAdmin } = vi.hoisted(() => ({
  mockPeople: { people: vi.fn(), file: vi.fn(), review: vi.fn(), bans: vi.fn(), note: vi.fn(), lookedAt: vi.fn() },
  mockAdmin: { integrityJob: vi.fn(), integrityRun: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, peopleApi: mockPeople, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { PeopleSearch } = await import('./admin/PeopleSearch');
const { NeedsALook } = await import('./admin/NeedsALook');
const { AnalysisPanel } = await import('./admin/AnalysisPanel');
const { PeopleBans } = await import('./admin/PeopleBans');

const row: AdminPlayerRow = {
  steamid: '76561199000000001', name: 'griefer', avatar: null, status: 'active', isAdmin: false,
  isMod: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 2,
};

const health = () => ({
  bursts: 12, detections: 1, lilacFlags: 2, lastBurstAt: '2026-09-20T10:00:00.000Z',
  lastFlagAt: '2026-09-20T10:00:00.000Z', matchesWithBursts: 3, caps: 0,
});

const lookRow: NeedsALookRow = {
  steamid: '76561199000000001', name: 'griefer', avatar: null, status: 'active',
  newestEvidenceAt: '2026-09-21T10:00:00.000Z', sources: ['lilac', 'analyzer'],
  lastReviewAt: null, lastReviewBy: null, openTickets: 1,
  analyzer: {
    steamid: '76561199000000001', ranked: true, rank: 3, of: 40, rounds: 20, eligibleRounds: 18,
    clips: 2, trackShare: 0.21, occZ: 1.1, teamGap: 0.4, pFid: 0.9, pOcc: 0.8, pGap: 0.7, composite: 0.8,
  },
};

const ban: PeopleBan = {
  id: 1, steamid: '76561199000000001', name: 'griefer', reason: 'throwing', length: '1 day',
  createdAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-21T10:00:00.000Z', createdByName: 'boss',
  liftedAt: null, liftedByName: null, active: true, ticketId: 12, withheld: false, canOpen: true,
};

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [...Object.values(mockPeople), ...Object.values(mockAdmin)]) fn.mockReset();
  mockPeople.people.mockResolvedValue({ players: [row] });
  mockPeople.review.mockResolvedValue({ players: [], health: health() });
  mockPeople.bans.mockResolvedValue({ bans: [] });
  mockPeople.lookedAt.mockResolvedValue({ ok: true, review: { id: 1, steamid: row.steamid, reviewedBy: '9', reviewedByName: 'boss', reviewedAt: '2026-09-21T00:00:00.000Z', note: '' } });
  mockAdmin.integrityJob.mockResolvedValue({
    available: true,
    job: { status: 'idle', mode: null, startedAt: null, finishedAt: null, exitCode: null, output: [] },
    pending: 0,
    matchInFlight: false,
  });
  mockAdmin.integrityRun.mockResolvedValue({ ok: true });
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

describe('Needs a look', () => {
  it('lists a player with their sources, rank and a way into the file', async () => {
    mockPeople.review.mockResolvedValue({ players: [lookRow], health: health() });
    render(<NeedsALook isAdmin />);
    const link = await screen.findByRole('link', { name: 'griefer' });
    expect(link.getAttribute('href')).toBe('/admin/people/76561199000000001');
    // Scoped to the player's own row: the capture-health line below the table
    // also says "Little Anti-Cheat" (its flag count), so an unscoped query is
    // ambiguous between the row's source badge and that unrelated sentence.
    const row = link.closest('tr')!;
    expect(within(row).getByText(/Little Anti-Cheat/)).toBeTruthy();
    expect(within(row).getByText(/Replay analyzer/)).toBeTruthy();
    expect(within(row).getByText(/3 of 40/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '1 open ticket' }).getAttribute('href'))
      .toBe('/admin/people/tickets');
  });

  it('marks a file looked at from the list', async () => {
    mockPeople.review.mockResolvedValue({ players: [lookRow], health: health() });
    render(<NeedsALook isAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: 'Looked at' }));
    await waitFor(() => expect(mockPeople.lookedAt).toHaveBeenCalledWith('76561199000000001', ''));
  });

  // The analysis panel asks an admin-only endpoint, so a moderator opening
  // this screen would have produced a 403 on every visit.
  it('leaves the analysis panel off a moderator\'s screen', async () => {
    render(<NeedsALook isAdmin={false} />);
    expect(await screen.findByText('Nothing is waiting to be looked at.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-analyse all replays' })).toBeNull();
    expect(mockAdmin.integrityJob).not.toHaveBeenCalled();
  });

  it('gives an admin the analysis panel', async () => {
    render(<NeedsALook isAdmin />);
    expect(await screen.findByRole('button', { name: 'Re-analyse all replays' })).toBeTruthy();
    expect(mockAdmin.integrityJob).toHaveBeenCalled();
  });

  it('says whether anything is being captured at all when the list is empty', async () => {
    render(<NeedsALook isAdmin />);
    expect(await screen.findByText('Nothing is waiting to be looked at.')).toBeTruthy();
    expect(screen.getByText(/12 input bursts/)).toBeTruthy();
  });
});

describe('the analysis panel', () => {
  it('runs an analysis and says where this panel is going', async () => {
    render(<AnalysisPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-analyse all replays' }));
    await waitFor(() => expect(mockAdmin.integrityRun).toHaveBeenCalledWith('full', false));
    expect(screen.getByText(/moves to Setup/)).toBeTruthy();
  });

  it('says so plainly when there is no replay directory', async () => {
    mockAdmin.integrityJob.mockResolvedValue({ available: false });
    render(<AnalysisPanel />);
    expect(await screen.findByText(/nothing to analyse/)).toBeTruthy();
  });
});

describe('the ban list', () => {
  it('lists bans, filters them, and opens the file behind each one', async () => {
    mockPeople.bans.mockResolvedValue({ bans: [ban] });
    render(<PeopleBans />);
    expect((await screen.findByRole('link', { name: 'griefer' })).getAttribute('href'))
      .toBe('/admin/people/76561199000000001');
    expect(screen.getByText('throwing')).toBeTruthy();
    expect(screen.getByText('1 day')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('/admin/people/tickets/12');
    expect(mockPeople.bans).toHaveBeenCalledWith('active', '', expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: 'Expired' }));
    await waitFor(() => expect(mockPeople.bans).toHaveBeenCalledWith('expired', '', expect.anything()));
  });

  it('shows a withheld reason as text and offers no file link a moderator cannot use', async () => {
    mockPeople.bans.mockResolvedValue({
      bans: [{ ...ban, reason: 'Withheld (restricted ticket)', createdByName: null, ticketId: null, withheld: true, canOpen: false }],
    });
    render(<PeopleBans />);
    expect(await screen.findByText('Withheld (restricted ticket)')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'griefer' })).toBeNull();
    expect(screen.getByText('griefer')).toBeTruthy();
  });
});
