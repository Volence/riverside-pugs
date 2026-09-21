import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { TicketDetail, TicketSummary } from '../api';
import { ConfirmHost } from '../components/Confirm';

const { mockMod, mockAdmin } = vi.hoisted(() => ({
  mockMod: {
    tickets: vi.fn(), ticket: vi.fn(), claim: vi.fn(), restrict: vi.fn(), access: vi.fn(),
    ban: vi.fn(), close: vi.fn(), reopen: vi.fn(), open: vi.fn(),
  },
  mockAdmin: { players: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, modApi: mockMod, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { Admin } = await import('./Admin');

const summary: TicketSummary = {
  id: 12, targetId: '7', targetName: 'Walls', status: 'open', outcome: null, restricted: false,
  claimedBy: null, claimedByName: null, reports: 2, reporters: 2, categories: ['cheating', 'griefing'],
  createdAt: '2026-09-21T10:00:00.000Z', lastReportAt: '2026-09-21T11:00:00.000Z', closedAt: null,
};
const detail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  ticket: { ...summary, outcomeNote: '', openedBy: null, openedByName: null, closedBy: null, closedByName: null },
  reports: [{ id: 1, reporterId: '3', reporterName: 'Rep', category: 'cheating', text: 'saw me through a wall', matchId: 66, campaign: 'dead_air', moment: { ordinal: 2, half: 1, tMs: 61500 }, createdAt: '2026-09-21T10:00:00.000Z' }],
  events: [{ id: 1, actorId: null, actorName: null, kind: 'opened', detail: {}, createdAt: '2026-09-21T10:00:00.000Z' }],
  bans: [], access: [], accessCandidates: [],
  caseFile: { steamid: '7', name: 'Walls', avatar: null, status: 'active', sr: 1500, games: 40, createdAt: '2026-08-01', activeBan: null, bans: [], penalties: [], timeout: null, inputFlags: [], aliases: [], sharesAddressWith: [], tickets: [summary] },
  viewer: { isAdmin: false, banCapMinutes: 10080 },
  ...over,
});

const mod = { steamid: '1', name: 'mod', avatar: null, status: 'active', isAdmin: false, isMod: true };

afterEach(() => { cleanup(); history.replaceState(null, '', '/admin'); });
beforeEach(() => {
  for (const fn of [...Object.values(mockMod), ...Object.values(mockAdmin)]) fn.mockReset();
  mockMod.tickets.mockResolvedValue({ tickets: [summary] });
  mockMod.ticket.mockResolvedValue(detail());
  for (const k of ['claim', 'restrict', 'access', 'ban', 'close', 'reopen'] as const) mockMod[k].mockResolvedValue({ ok: true });
});

describe('the Tickets tab', () => {
  it('refuses a plain player', () => {
    render(<Admin session={{ kind: 'active', me: { ...mod, isMod: false } }} />);
    expect(screen.getByText('Staff only.')).toBeTruthy();
    expect(mockMod.tickets).not.toHaveBeenCalled();
  });

  it('a moderator sees only Tickets, and never calls the admin API', async () => {
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('Walls');
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Players' })).toBeNull();
    expect(mockAdmin.players).not.toHaveBeenCalled();
    expect(screen.getByText(/2 reports from 2 people/)).toBeTruthy();
  });

  it('opens a ticket, shows the report with its replay link, and claims it', async () => {
    render(<Admin session={{ kind: 'active', me: mod }} />);
    fireEvent.click(await screen.findByText('Walls'));
    await screen.findByText('saw me through a wall');
    const replay = screen.getByRole('link', { name: /replay moment/i }) as HTMLAnchorElement;
    expect(replay.getAttribute('href')).toBe('/match/66?ordinal=2&half=1&t=61500');
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(mockMod.claim).toHaveBeenCalledWith(12, true));
  });

  it('opens straight to a ticket from the link the feed posts', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('saw me through a wall');
    expect(mockMod.ticket).toHaveBeenCalledWith(12, expect.anything());
  });

  it('closes with an outcome and a note', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('saw me through a wall');
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'warned' } });
    fireEvent.input(screen.getByLabelText('Closing note'), { target: { value: 'first time' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
    await waitFor(() => expect(mockMod.close).toHaveBeenCalledWith(12, 'warned', 'first time'));
    expect(screen.queryByText(/The ban reason is shown to the player/)).toBeNull();
  });

  it('a moderator cannot pick permanent, and the ban asks first', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<><Admin session={{ kind: 'active', me: mod }} /><ConfirmHost /></>);
    await screen.findByText('saw me through a wall');
    const length = screen.getByLabelText('Ban length') as HTMLSelectElement;
    expect([...length.options].map((o) => o.value)).toEqual(['60', '1440', '4320', '10080']);
    fireEvent.input(screen.getByLabelText('Ban reason'), { target: { value: 'walls' } });
    fireEvent.change(length, { target: { value: '1440' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(mockMod.ban).toHaveBeenCalledWith(12, 'walls', 1440));
  });

  it('an admin is offered longer bans and permanent', async () => {
    mockMod.ticket.mockResolvedValue(detail({ viewer: { isAdmin: true, banCapMinutes: null } }));
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: { ...mod, isAdmin: true } }} />);
    await screen.findByText('saw me through a wall');
    const values = [...(screen.getByLabelText('Ban length') as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toEqual(['60', '1440', '4320', '10080', '43200', '']);
  });

  it('a restricted ticket says so, warns about Discord, and lists who can see it', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, restricted: true },
      access: [{ steamid: '9', name: 'Owner' }], accessCandidates: [{ steamid: '5', name: 'Other' }],
    }));
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText(/Restricted/);
    expect(screen.getByText(/Discord Administrator/)).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText(/The ban reason is shown to the player/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Give access to'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give access' }));
    await waitFor(() => expect(mockMod.access).toHaveBeenCalledWith(12, '5'));
  });
});
