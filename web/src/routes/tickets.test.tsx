import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { TicketDetail, TicketSummary } from '../api';
import { ConfirmHost } from '../components/Confirm';
import { eventName, TICKETS_EVENT } from '../hooks/useTicketNudge';

const { mockMod, mockAdmin } = vi.hoisted(() => ({
  mockMod: {
    tickets: vi.fn(), ticket: vi.fn(), claim: vi.fn(), restrict: vi.fn(), access: vi.fn(),
    ban: vi.fn(), close: vi.fn(), reopen: vi.fn(), open: vi.fn(), removeMessage: vi.fn(),
  },
  mockAdmin: { players: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, modApi: mockMod, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { Admin } = await import('./Admin');
const { LocationProvider } = await import('preact-iso');

const summary: TicketSummary = {
  id: 12, targetId: '7', targetDiscordId: null, targetName: 'Walls', status: 'open', outcome: null, restricted: false,
  claimedBy: null, claimedByName: null, reports: 2, reporters: 2, categories: ['cheating', 'griefing'],
  createdAt: '2026-09-21T10:00:00.000Z', lastReportAt: '2026-09-21T11:00:00.000Z', closedAt: null,
};
const detail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  ticket: { ...summary, outcomeNote: '', openedBy: null, openedByName: null, closedBy: null, closedByName: null },
  reports: [{ id: 1, reporterId: '3', reporterDiscordId: null, reporterName: 'Rep', category: 'cheating', text: 'saw me through a wall', matchId: 66, campaign: 'dead_air', moment: { ordinal: 2, half: 1, tMs: 61500 }, createdAt: '2026-09-21T10:00:00.000Z' }],
  events: [{ id: 1, actorId: null, actorName: null, kind: 'opened', detail: {}, createdAt: '2026-09-21T10:00:00.000Z' }],
  bans: [], access: [], accessCandidates: [],
  discussion: { state: 'unconfigured', surface: null, url: null },
  messages: [],
  caseFile: { steamid: '7', name: 'Walls', avatar: null, status: 'active', sr: 1500, games: 40, createdAt: '2026-08-01', activeBan: null, bans: [], penalties: [], timeout: null, inputFlags: [], aliases: [], sharesAddressWith: [], tickets: [summary] },
  summary: {
    steamid: '7', name: 'Walls', avatar: null, status: 'active', isAdmin: false, isMod: false,
    sr: 1500, games: 40, createdAt: '2026-08-01', activeBan: null, bans: 0, penalties: 0,
    timeout: null, openTickets: 1, aliases: 0, sharesAddressWith: [], steamFlags: [],
    evidence: [{ source: 'lilac', count: 1 }], analyzer: null, lastReview: null,
    fileUrl: '/admin/people/7',
  },
  viewer: { isAdmin: false, banCapMinutes: 10080 },
  ...over,
});

const mod = { steamid: '1', name: 'mod', avatar: null, status: 'active', isAdmin: false, isMod: true };

/** Every screen in the panel is a URL now, so a test says which one it is
 *  opening rather than clicking its way there. */
const renderAdmin = (path: string, me: typeof mod) => {
  history.replaceState(null, '', path);
  return render(
    <LocationProvider>
      <Admin session={{ kind: 'active', me }} />
      <ConfirmHost />
    </LocationProvider>,
  );
};

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
beforeEach(() => {
  for (const fn of [...Object.values(mockMod), ...Object.values(mockAdmin)]) fn.mockReset();
  mockMod.tickets.mockResolvedValue({ tickets: [summary], counts: { open: 3, mine: 1, closed: 12 } });
  mockMod.ticket.mockResolvedValue(detail());
  for (const k of ['claim', 'restrict', 'access', 'ban', 'close', 'reopen'] as const) mockMod[k].mockResolvedValue({ ok: true });
});

describe('the Tickets section', () => {
  it('refuses a plain player', () => {
    renderAdmin('/admin/people/tickets', { ...mod, isMod: false });
    expect(screen.getByText('Staff only.')).toBeTruthy();
    expect(mockMod.tickets).not.toHaveBeenCalled();
  });

  it('a moderator sees the People desk only, and never calls the admin API', async () => {
    renderAdmin('/admin/people/tickets', mod);
    await screen.findByText('Walls');
    expect(screen.queryByRole('tab', { name: 'Live' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Setup' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Needs a look' })).toBeTruthy();
    expect(mockAdmin.players).not.toHaveBeenCalled();
    expect(screen.getByText(/2 reports from 2 people/)).toBeTruthy();
  });

  it('says when the Discord discussion is not configured, and links to it when it exists', async () => {
    const first = renderAdmin('/admin/people/tickets/12', mod);
    await screen.findByText(/Discord discussion is not configured/);
    first.unmount();
    mockMod.ticket.mockResolvedValue(detail({ discussion: { state: 'ready', surface: 'forum', url: 'https://discord.com/channels/g1/555' } }));
    renderAdmin('/admin/people/tickets/12', mod);
    const link = await screen.findByRole('link', { name: /staff thread in Discord/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://discord.com/channels/g1/555');
  });

  it('shows a count on each filter', async () => {
    renderAdmin('/admin/people/tickets', mod);
    await screen.findByText('Walls');
    expect(screen.getByRole('tab', { name: /Open/ }).textContent).toBe('Open3');
    expect(screen.getByRole('tab', { name: /Mine/ }).textContent).toBe('Mine1');
    expect(screen.getByRole('tab', { name: /Closed/ }).textContent).toBe('Closed12');
  });

  it('opens a ticket from the list at its own URL', async () => {
    renderAdmin('/admin/people/tickets', mod);
    fireEvent.click(await screen.findByText('Walls'));
    await screen.findByText('saw me through a wall');
    expect(location.pathname).toBe('/admin/people/tickets/12');
    const replay = screen.getByRole('link', { name: /replay moment/i }) as HTMLAnchorElement;
    expect(replay.getAttribute('href')).toBe('/match/66?ordinal=2&half=1&t=61500');
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(mockMod.claim).toHaveBeenCalledWith(12, true));
  });

  it('opens straight to a ticket from an old feed link', async () => {
    renderAdmin('/admin?ticket=12', mod);
    await screen.findByText('saw me through a wall');
    expect(mockMod.ticket).toHaveBeenCalledWith(12, expect.anything());
    expect(location.pathname).toBe('/admin/people/tickets/12');
  });

  it('refuses a ticket URL that is not an id', async () => {
    renderAdmin('/admin/people/tickets/abc', mod);
    expect(await screen.findByText('No such page in the panel.')).toBeTruthy();
    expect(mockMod.ticket).not.toHaveBeenCalled();
  });

  it('closes with an outcome and a note', async () => {
    renderAdmin('/admin/people/tickets/12', mod);
    await screen.findByText('saw me through a wall');
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'warned' } });
    fireEvent.input(screen.getByLabelText('Closing note'), { target: { value: 'first time' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
    await waitFor(() => expect(mockMod.close).toHaveBeenCalledWith(12, 'warned', 'first time'));
    expect(screen.queryByText(/The ban reason is shown to the player/)).toBeNull();
  });

  it('a moderator cannot pick permanent, and the ban asks first', async () => {
    renderAdmin('/admin/people/tickets/12', mod);
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
    renderAdmin('/admin/people/tickets/12', { ...mod, isAdmin: true });
    await screen.findByText('saw me through a wall');
    const values = [...(screen.getByLabelText('Ban length') as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toEqual(['60', '1440', '4320', '10080', '43200', '']);
  });

  it('a restricted ticket says so, warns about Discord, and lists who can see it', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, restricted: true },
      access: [{ steamid: '9', name: 'Owner' }], accessCandidates: [{ steamid: '5', name: 'Other' }],
    }));
    renderAdmin('/admin/people/tickets/12', mod);
    await screen.findByText(/Restricted/);
    expect(screen.getByText(/Discord Administrator/)).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText(/The ban reason is shown to the player/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Give access to'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give access' }));
    await waitFor(() => expect(mockMod.access).toHaveBeenCalledWith(12, '5'));
  });

  it('shows the accused\'s summary with a way into their file', async () => {
    const { container } = renderAdmin('/admin/people/tickets/12', mod);
    await screen.findByText('saw me through a wall');
    // Scoped to .file-summary: the kept case-file section also says "About
    // Walls", since both read the same accused's name.
    const section = container.querySelector('.file-summary') as HTMLElement;
    expect(section).toBeTruthy();
    expect(within(section).getByText('About Walls')).toBeTruthy();
    expect(within(section).getByText(/1 Little Anti-Cheat/)).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Open full file' }).getAttribute('href')).toBe('/admin/people/7');
  });

  it('refetches the open ticket when the staff nudge arrives, and only knows a well formed frame', async () => {
    renderAdmin('/admin/people/tickets/12', mod);
    await screen.findByText('saw me through a wall');
    expect(mockMod.ticket).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(TICKETS_EVENT));
    await waitFor(() => expect(mockMod.ticket).toHaveBeenCalledTimes(2));
    expect(eventName('{"event":"tickets"}')).toBe('tickets');
    expect(eventName('{"event":7}')).toBeNull();
    expect(eventName('not json')).toBeNull();
    expect(eventName(new ArrayBuffer(2))).toBeNull();
  });
});
