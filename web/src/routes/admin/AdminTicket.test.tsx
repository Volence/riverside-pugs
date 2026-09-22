import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { CaseFile, DiscordSanction, FileSummaryData, TicketDetail } from '../../api';

const { mockMod } = vi.hoisted(() => ({ mockMod: { ticket: vi.fn() } }));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});

const { AdminTicket } = await import('./AdminTicket');

const NAME = 'Bone Breaker';

const summary: FileSummaryData = {
  steamid: '76561198000000011', name: NAME, avatar: null, status: 'active',
  isAdmin: false, isMod: false, sr: null, games: 2, createdAt: '2026-08-18T01:35:32.000Z',
  activeBan: null, bans: 0, penalties: 0, timeout: null, openTickets: 1, aliases: 0,
  sharesAddressWith: [], steamFlags: [],
  evidence: [{ source: 'analyzer', count: 3 }], analyzer: null, lastReview: null,
  fileUrl: '/admin/people/76561198000000011',
};

const caseFile: CaseFile = {
  steamid: '76561198000000011', name: NAME, avatar: null, status: 'active', sr: null, games: 2,
  createdAt: '2026-08-18T01:35:32.000Z', activeBan: null, bans: [], penalties: [], timeout: null,
  inputFlags: [], aliases: [], sharesAddressWith: [],
  tickets: [{
    id: 7, targetId: '76561198000000011', targetDiscordId: null, targetName: NAME, status: 'closed', outcome: 'warned',
    restricted: false, claimedBy: null, claimedByName: null, reports: 1, reporters: 1,
    categories: ['toxicity'], createdAt: '2026-08-30T10:00:00.000Z', lastReportAt: null,
    closedAt: '2026-08-31T10:00:00.000Z',
  }],
};

const detail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  discussion: { state: 'unconfigured', surface: null, url: null },
  ticket: {
    id: 1, targetId: '76561198000000011', targetDiscordId: null, targetName: NAME, status: 'open', outcome: null,
    restricted: false, claimedBy: null, claimedByName: null, reports: 2, reporters: 2,
    categories: ['cheating'], createdAt: '2026-09-21T18:56:13.000Z', lastReportAt: null, closedAt: null,
    outcomeNote: '', openedBy: null, openedByName: null, closedBy: null, closedByName: null,
  },
  reports: [], events: [], bans: [], discordSanctions: [], access: [], accessCandidates: [], messages: [],
  caseFile, summary, viewer: { isAdmin: true, banCapMinutes: null },
  ...over,
});

const DISCORD_TARGET = { targetId: null, targetDiscordId: '990000000000000001', targetName: 'Lurky' };

const sanctionRow: DiscordSanction = {
  id: 5, kind: 'timeout', until: '2026-09-23T00:00:00.000Z', reason: 'spam', ticketId: 1,
  createdBy: '76561198000000099', createdByName: 'ModOne', createdAt: '2026-09-22T00:00:00.000Z',
  liftedBy: null, liftedAt: null, active: true,
};

/** What the server hands back for a sanction tied to a restricted ticket
 *  the viewer is not on: ticketId null, no issuer, the fixed withheld text. */
const redactedSanctionRow: DiscordSanction = {
  id: 6, kind: 'ban', until: null, reason: 'Withheld (restricted ticket)', ticketId: null,
  createdBy: '', createdByName: null, createdAt: '2026-09-22T00:00:00.000Z',
  liftedBy: null, liftedAt: null, active: true,
};

beforeEach(() => { mockMod.ticket.mockReset(); });
afterEach(cleanup);

describe('AdminTicket', () => {
  /** The shared summary was added above a case-file section that already
   *  opened with the same words, so the page grew two adjacent headings
   *  reading "About <name>" with different figures under each. */
  it('heads the accused only once, even with both the summary and the case file', async () => {
    mockMod.ticket.mockResolvedValue(detail());
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(`About ${NAME}`)).toBeTruthy());
    expect(screen.queryAllByText(`About ${NAME}`)).toHaveLength(1);
    // The status line opened both blocks too, field for identical field.
    expect(screen.queryAllByText(/active · SR n\/a · 2 games/)).toHaveLength(1);
    expect(screen.getByText('Case file')).toBeTruthy();
  });

  it('keeps the summary with its link to the full file', async () => {
    mockMod.ticket.mockResolvedValue(detail());
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    const link = await screen.findByText('Open full file');
    expect(link.getAttribute('href')).toBe('/admin/people/76561198000000011');
  });

  it('keeps the case file detail and the earlier tickets under it', async () => {
    mockMod.ticket.mockResolvedValue(detail());
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('Earlier tickets')).toBeTruthy();
    expect(screen.getByText('#7')).toBeTruthy();
  });

  /** A moderator added to a restricted ticket about a colleague gets
   *  summary.fileUrl null, and can get no summary at all; the case file is
   *  then the only record of the accused on the page. */
  it('still names the accused when there is no summary to head', async () => {
    mockMod.ticket.mockResolvedValue(detail({ summary: null }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(`About ${NAME}`)).toBeTruthy());
    expect(screen.queryByText('Open full file')).toBeNull();
  });

  it('shows no Discord controls or sanctions list on a player ticket', async () => {
    mockMod.ticket.mockResolvedValue(detail());
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Ban' });
    expect(screen.queryByRole('button', { name: 'Time out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ban from Discord' })).toBeNull();
    expect(screen.queryByText('Discord sanctions')).toBeNull();
  });

  it('shows Time out but no server Ban control for a Discord-only ticket', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      viewer: { isAdmin: false, banCapMinutes: 10080 },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Time out' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ban from Discord' })).toBeNull();
  });

  it('shows Ban from Discord only to an admin', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      viewer: { isAdmin: true, banCapMinutes: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Ban from Discord' })).toBeTruthy();
  });

  it('shows a Lift button on an active Discord sanction only to an admin', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      discordSanctions: [sanctionRow],
      viewer: { isAdmin: false, banCapMinutes: 10080 },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    await screen.findByText('Discord sanctions');
    expect(screen.queryByRole('button', { name: 'Lift' })).toBeNull();
  });

  it('lets an admin lift an active Discord sanction', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      discordSanctions: [sanctionRow],
      viewer: { isAdmin: true, banCapMinutes: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Lift' })).toBeTruthy();
  });

  it('shows a redacted sanction with no dangling "by" and offers no Lift, even to an admin', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      discordSanctions: [redactedSanctionRow],
      viewer: { isAdmin: true, banCapMinutes: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('Banned from the Discord: Withheld (restricted ticket)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lift' })).toBeNull();
  });

  it('lists the accused\'s Discord sanctions in the case file', async () => {
    mockMod.ticket.mockResolvedValue(detail({ caseFile: { ...caseFile, discordSanctions: [redactedSanctionRow] } }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('Banned from the Discord: Withheld (restricted ticket)')).toBeTruthy();
  });

  it('caps the Time out select at a day for a moderator capped there, and offers no Permanent', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      viewer: { isAdmin: false, banCapMinutes: 1440 },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    const select = await screen.findByRole('combobox', { name: 'Timeout length' });
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['1 hour', '1 day']);
    expect(options).not.toContain('Permanent');
    expect((select as HTMLSelectElement).value).toBe('1440');
  });

  // The Time out select must have its own list, not the server ban's LENGTHS
  // (whose longest is 30 days but which caps out well short of Discord's own
  // 28-day maximum on the way there): an admin, with no ban cap at all,
  // should still see the full run up to 28 days.
  it('lets an admin see the full run of timeout lengths up to 28 days', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      viewer: { isAdmin: true, banCapMinutes: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    const select = await screen.findByRole('combobox', { name: 'Timeout length' });
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['1 hour', '1 day', '3 days', '7 days', '14 days', '28 days']);
  });

  // A moderator capped at 10080 (7 days, LENGTHS' longest short of
  // Permanent) must not see 28 days: the cap is real, only the list grew.
  it('does not offer 28 days to a moderator capped at 10080', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      viewer: { isAdmin: false, banCapMinutes: 10080 },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    const select = await screen.findByRole('combobox', { name: 'Timeout length' });
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['1 hour', '1 day', '3 days', '7 days']);
    expect(options).not.toContain('28 days');
  });

  it('disables Time out when a cap of 0 leaves no timeout length to offer', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET },
      caseFile: null, summary: null,
      viewer: { isAdmin: false, banCapMinutes: 0 },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Time out' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Timeout length' })?.querySelectorAll('option')).toHaveLength(0);
  });

  it('tells a restricted Discord-only ticket the reason goes to Discord\'s audit log, not the server-ban wording', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, ...DISCORD_TARGET, restricted: true },
      caseFile: null, summary: null,
      viewer: { isAdmin: true, banCapMinutes: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/goes to Discord's audit log/)).toBeTruthy();
    expect(screen.queryByText(/shown to the player and in the ban list/)).toBeNull();
  });

  it('keeps the server-ban restricted wording for a player ticket', async () => {
    mockMod.ticket.mockResolvedValue(detail({ ticket: { ...detail().ticket, restricted: true } }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/shown to the player and in the ban list/)).toBeTruthy();
    expect(screen.queryByText(/goes to Discord's audit log/)).toBeNull();
  });

  it('says a restricted ticket is worked here, with no Discord thread', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, restricted: true },
      discussion: { state: 'restricted', surface: null, url: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/Restricted tickets have no Discord thread/)).toBeTruthy();
    expect(screen.getByText(/It has no Discord thread, so keep the discussion on this page/)).toBeTruthy();
  });

});
