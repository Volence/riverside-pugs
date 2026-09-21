import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { CaseFile, FileSummaryData, TicketDetail } from '../../api';

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
    id: 7, targetId: '76561198000000011', targetName: NAME, status: 'closed', outcome: 'warned',
    restricted: false, claimedBy: null, claimedByName: null, reports: 1, reporters: 1,
    categories: ['toxicity'], createdAt: '2026-08-30T10:00:00.000Z', lastReportAt: null,
    closedAt: '2026-08-31T10:00:00.000Z',
  }],
};

const detail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  ticket: {
    id: 1, targetId: '76561198000000011', targetName: NAME, status: 'open', outcome: null,
    restricted: false, claimedBy: null, claimedByName: null, reports: 2, reporters: 2,
    categories: ['cheating'], createdAt: '2026-09-21T18:56:13.000Z', lastReportAt: null, closedAt: null,
    outcomeNote: '', openedBy: null, openedByName: null, closedBy: null, closedByName: null,
  },
  reports: [], events: [], bans: [], access: [], accessCandidates: [],
  caseFile, summary, viewer: { isAdmin: true, banCapMinutes: null },
  ...over,
});

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
});
