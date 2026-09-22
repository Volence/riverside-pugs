import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { IntegrityRound, PlayerFileData } from '../api';
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
// Mirrors src/admin/fileAccess.ts's ADMIN_ACTIONS: review_round and
// steam_refresh are both admin-only gates the file's controls read directly,
// so a file() built with anything less would under-test them by accident.
const ADMIN_ACTIONS = [
  'note', 'looked_at', 'open_ticket', 'ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags',
  'review_round', 'steam_refresh',
] as const;

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

  it('names the countries a player connects from rather than printing their codes', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        identity: {
          ...file().sections.identity,
          networks: [{ ipHash: 'h1', country: 'US', firstSeen: '2026-09-01', lastSeen: '2026-09-02', seenCount: 1 }],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText(/Connects from United States/)).toBeTruthy();
    expect(screen.getByText(/4 connects, United States/)).toBeTruthy();
  });

  it('shows ready-up and pause conduct beside the league, and links each match to its chat', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        conduct: {
          readyups: {
            count: 22, avgSeconds: 38, timesLast: 9, leagueAvgSeconds: 12, leagueLastShare: 0.125,
            slowest: [{ matchId: 44, mapOrdinal: 1, half: 2, seconds: 95, wasLast: true }],
          },
          pauses: {
            trackedSince: '2026-09-23 00:00:00', called: 3, matchesSince: 5, totalSeconds: 250,
            recent: [{ matchId: 45, mapOrdinal: 0, half: 1, seconds: 120, startedAt: '2026-09-23 01:00:00' }],
          },
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByRole('heading', { name: 'Conduct' })).toBeTruthy();
    expect(screen.getByText(/league 0:12/)).toBeTruthy();
    expect(screen.getByText(/9 of 22/)).toBeTruthy();
    expect(screen.getByText(/about 1 in 8/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '#44' }).getAttribute('href')).toBe('/match/44');
    expect(screen.getByText(/pauses called in 5 matches/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'chat' }).getAttribute('href')).toBe(`/match/7?chat=${P}#chat`);
  });

  it('says pauses are not tracked yet rather than showing a zero', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        conduct: {
          readyups: { count: 0, avgSeconds: null, timesLast: 0, leagueAvgSeconds: null, leagueLastShare: null, slowest: [] },
          pauses: { trackedSince: null, called: 0, matchesSince: 0, totalSeconds: 0, recent: [] },
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText(/Not tracked yet/)).toBeTruthy();
    expect(screen.getByText('No finished ready-ups on record.')).toBeTruthy();
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

  it('signs a player out everywhere, after asking', async () => {
    render(<><PlayerFile steamid={P} me="76561199000000009" /><ConfirmHost /></>);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockAdmin.signOutPlayer).toHaveBeenCalledWith(P));
  });

  it('says which other Steam account a player\'s Discord used to be on', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        identity: {
          ...file().sections.identity,
          discordHistory: [{
            discordId: '111', discordName: 'Alice', linkedAt: '2026-09-20T00:00:00.000Z', linkedBy: '2', unlinkedAt: null, unlinkedBy: null,
            others: [{ steamid: '76561199000000002', name: 'banned main', linkedAt: '2026-08-01T00:00:00.000Z', unlinkedAt: '2026-09-19T00:00:00.000Z' }],
          }],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(await screen.findByText(/This Discord was previously linked to/)).toBeTruthy();
    expect((screen.getByText('banned main') as HTMLAnchorElement).getAttribute('href')).toBe('/admin/people/76561199000000002');
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
    // Check now is gated on the dedicated steam_refresh action, not merge:
    // a moderator has neither, so it should not appear either way.
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    // The sections themselves are not hidden from a moderator: only actions.
    expect(screen.getByText(/Seen on the same connection as/)).toBeTruthy();
    expect(screen.getByText('throwing')).toBeTruthy();
  });

  it('offers an admin "Check now" on the Steam account panel', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('previews a merge before offering to run one, with what it moves table by table', async () => {
    mockAdmin.mergePlayer.mockResolvedValue({
      plan: {
        from: P, into: '76561199000000002', matchesMoved: 3, matchesCollapsed: 1,
        rowsByTable: { bans: 1, notes: 2 }, seasons: [1],
      },
    });
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByPlaceholderText('SteamID64 to keep'), { target: { value: '76561199000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(mockAdmin.mergePlayer).toHaveBeenCalledWith(P, '76561199000000002', true));
    // A bare /3/ also matches the header's join date and the "3 days" steam
    // flag; pin this to the plan's own bolded matchesMoved count instead.
    expect(await screen.findByText((_, el) => el?.tagName === 'STRONG' && el.textContent === '3')).toBeTruthy();
    // An admin must see what a merge will move, table by table, before
    // confirming: matchesMoved alone hides everything else that comes along.
    const plan = document.querySelector('.admin-merge__plan') as HTMLElement;
    expect(within(plan).getByText('bans').closest('li')?.textContent).toBe('bans 1');
    expect(within(plan).getByText('notes').closest('li')?.textContent).toBe('notes 2');
    expect(screen.getByRole('button', { name: 'Merge and recompute' })).toBeTruthy();
  });
});

describe('the evidence timeline', () => {
  const withTimeline = () => file({
    timeline: [
      {
        at: '2026-09-21T10:00:00.000Z', source: 'analyzer', kind: 'track',
        summary: 'Analyzer clip: track, fidelity 0.82 over 6.0 s. Watch it before deciding anything.',
        matchId: 7, replay: { ordinal: 2, half: 1, tMs: 61500 }, ref: { type: 'integrity_clip', id: 4 },
      },
      {
        at: '2026-09-20T10:00:00.000Z', source: 'lilac', kind: 'aimbot',
        summary: 'Little Anti-Cheat suspected aimbot. Few and rare suspicions are usually false positives; a run of them is what matters.',
        matchId: 7, replay: null, ref: { type: 'integrity_flag', id: 2 },
      },
      {
        at: '2026-09-19T10:00:00.000Z', source: 'note', kind: 'note',
        summary: 'boss: had a word', matchId: null, replay: null, ref: { type: 'note', id: 1 },
      },
    ],
  });

  it('lists every row newest first, with its source and its links', async () => {
    mockPeople.file.mockResolvedValue(withTimeline());
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    const rows = await screen.findAllByRole('listitem');
    const timeline = rows.filter((r) => r.className.includes('timeline__row'));
    expect(timeline).toHaveLength(3);
    expect(timeline[0].textContent).toContain('Replay analyzer');
    expect(within(timeline[0]).getByRole('link', { name: 'replay moment' }).getAttribute('href'))
      .toBe('/match/7?ordinal=2&half=1&t=61500');
    expect(within(timeline[1]).queryByRole('link', { name: 'replay moment' })).toBeNull();
    expect(within(timeline[1]).getByRole('link', { name: '#7' })).toBeTruthy();
  });

  it('filters by source and back again', async () => {
    mockPeople.file.mockResolvedValue(withTimeline());
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    fireEvent.click(await screen.findByRole('button', { name: /Note/ }));
    await waitFor(() => {
      const shown = screen.getAllByRole('listitem').filter((r) => r.className.includes('timeline__row'));
      expect(shown).toHaveLength(1);
      expect(shown[0].textContent).toContain('had a word');
    });
    fireEvent.click(screen.getByRole('button', { name: /Everything/ }));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem').filter((r) => r.className.includes('timeline__row'))).toHaveLength(3);
    });
  });

  it('says when there is nothing rather than showing an empty list', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText('Nothing has been recorded about this player.')).toBeTruthy();
  });
});

const integrityRound = (over: Partial<IntegrityRound> = {}): IntegrityRound => ({
  matchId: 42, ordinal: 2, half: 1, slot: 3, campaign: 'farm',
  metrics: {
    fidMax: 0.5, fidP95: 0.3, windows: 4, scoreable: 2, fidSum: 0.6, occ: null, eligiblePairs: 10,
    gates: { considered: 40, notLive: 5, notGhost: 10, inGrace: 5, tooClose: 5, occluded: 5, passed: 10 },
  },
  computedAt: '2026-09-17T00:00:00Z', reviewState: 'new', reviewNote: '', ...over,
});

describe('the evidence detail', () => {
  it('shows the input bursts, the drops and the clips, and lets an admin review a round', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: {
            steamid: P, ranked: true, rank: 3, of: 40, rounds: 20, eligibleRounds: 18, clips: 1,
            trackShare: 0.21, occZ: 1.1, teamGap: 0.4, pFid: 0.9, pOcc: 0.8, pGap: 0.7, composite: 0.8,
          },
          rounds: [],
          clips: [{ id: 4, matchId: 7, ordinal: 2, half: 1, slot: 3, startMs: 61500, endMs: 67500, kind: 'track', score: 0.82, detail: {} }],
          flags: [{ id: 2, matchId: 7, steamid: P, source: 'lilac', kind: 'aimbot', severity: 'suspected', detail: '', at: '2026-09-20T10:00:00.000Z' }],
          inputFlags: [{
            id: 1, burstId: 1, matchId: 7, steamid: P, kind: 'attack', signature: 'pistol_rate',
            severity: 'low', at: '2026-09-20T10:00:00.000Z', hits: 3, note: 'wheel-like', bursts: [],
          }],
          inputCaps: [],
          signonDrops: { count: 1, lastAt: '2026-09-18T10:00:00.000Z', rows: [{ id: 1, name: 'ingame', secsConnected: 12, forcedCount: 651, at: '2026-09-18T10:00:00.000Z', enteredAfterAt: null }] },
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByText(/pistol_rate/)).toBeTruthy();
    expect(screen.getByText(/3 of 40/)).toBeTruthy();
    expect(screen.getByText(/651 files enforced/)).toBeTruthy();
    // Few and rare LilAC suspicions are usually false positives; only a
    // pattern is worth reading as something. This is the whole reason the
    // flag exists at all next to a real person's name.
    expect(screen.getByText(/few and rare suspicions are usually false positives/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Mark this round reviewed/ }));
    await waitFor(() => expect(mockAdmin.integrityReview).toHaveBeenCalledWith(7, 2, 1, 3, 'reviewed', ''));

    // Evidence, not a URL that doesn't exist: the clip's ordinal, half and
    // start time ride along so the replay viewer can seek to the moment.
    const link = screen.getByRole('link', { name: /Match #7/ });
    expect(link.getAttribute('href')).toBe('/match/7?ordinal=2&half=1&t=61500');
    expect(screen.getByText(/fidelity 0\.82/)).toBeTruthy();
    expect(screen.getByText(/6\.0s/)).toBeTruthy();
  });

  it('says so when nobody has a flagged moment from replay analysis', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByText('No flagged moments from replay analysis for this player.')).toBeTruthy();
  });

  // The column key shipped live and invisible for a day: it used `class="key"`,
  // which the replay viewer's floating legend styles `position: absolute`, so
  // the whole <details> was pulled out of its panel and left an empty box with
  // no summary to click. This asserts the name stays distinct.
  it('keeps the column key off the replay viewer\'s .key class', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    const summary = await screen.findByText('What these columns mean');
    const details = summary.closest('details');
    expect(details).toBeTruthy();
    expect(details!.classList.contains('key')).toBe(false);
    expect(details!.classList.contains('colkey')).toBe(true);
  });

  it('shows what an input flag rests on, what its holds look like, and any truncated capture', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, rounds: [], clips: [], flags: [],
          inputCaps: [{ matchId: 41, kind: 'bhop', serverTick: 9000, at: '2026-09-21T12:00:00.000Z' }],
          inputFlags: [{
            id: 1, burstId: 9, matchId: 41, steamid: P, kind: 'fire', signature: 'pistol_rate', severity: 'low',
            at: '2026-09-21T12:05:00.000Z', hits: 2, note: 'wheel-like',
            bursts: [{
              id: 8, at: '2026-09-21T12:04:00.000Z', weapon: 'weapon_pistol', presses: 51, ratePerSec: 13.04, meanTicks: 7.67,
              wire: 1, serverSpan: 384, annotation: 'wheel-like',
              hold: { n: 51, medianTicks: 1, minTicks: 1, maxTicks: 2, sdTicks: 0.2, oneTickFrac: 0.96, nearMedianFrac: 1 },
            }],
          }],
          signonDrops: { count: 0, lastAt: null, rows: [] },
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    // Not a verdict: low-severity input evidence gets the same caveat the
    // old screen gave it, before any burst detail.
    expect(screen.getByText(/Button timing that does not look like a hand/)).toBeTruthy();
    fireEvent.click(screen.getByText('The bursts that counted'));
    const text = screen.getByText(/pistol_rate/).closest('li')!.textContent!;
    expect(text).toContain('pistol_rate on 2 fire bursts');
    expect(text).toContain('low · holds: wheel-like');
    expect(text).toContain('13.0/s over 51 presses');
    expect(text).toContain('held 1 ticks median (1 to 2, sd 0.2)');
    expect(text).toContain('96% one-tick');
    // wire 1 means the plugin version that did not exclude ghosts yet.
    expect(text).toContain('plugin 0.1.0: server tick timing, ghosts not excluded');
    expect(text).toContain('wheel-like: nearly every press down for a single tick');
    expect(text).toContain('This describes the evidence; it does not change the flag.');
    const capText = screen.getByText(/Capture was cut short/).textContent!;
    expect(capText).toContain('Capture was cut short by the game server\'s per-round budget 1 time');
    // Which round it was cut short on is what a reviewer needs to correlate
    // a truncated capture with a specific round's evidence.
    expect(within(screen.getByText(/Capture was cut short/)).getByRole('link', { name: '#41' }).getAttribute('href')).toBe('/match/41');
    expect(capText).toContain('bhop');
  });

  it('says a connect drop\'s time honestly when it is unknown, and whether they got back in', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, rounds: [], clips: [], flags: [], inputFlags: [], inputCaps: [],
          signonDrops: {
            count: 2, lastAt: '2026-09-19T21:00:00.000Z',
            rows: [
              { id: 2, name: 'skinner', secsConnected: -1, forcedCount: 651, at: '2026-09-19T21:00:00.000Z', enteredAfterAt: null },
              { id: 1, name: 'skinner', secsConnected: 12, forcedCount: 651, at: '2026-09-19T20:00:00.000Z', enteredAfterAt: '2026-09-19T20:03:00.000Z' },
            ],
          },
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    const items = screen.getAllByRole('listitem').filter((li) => (li.textContent ?? '').includes('files enforced'));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('time unknown');
    expect(items[0].textContent).toContain('has not got in since');
    expect(items[1].textContent).toContain('after 12 s');
    expect(items[1].textContent).toContain('got in');
    expect(screen.getByRole('link', { name: 'What players are told' }).getAttribute('href')).toBe('/help/consistency');
  });

  it('puts ONE review control on a player-round, however many clips it holds, and can dismiss it', async () => {
    // Review state is keyed by the player-round, so a control per clip meant
    // clicking Reviewed on one six-second moment silently triaged up to five,
    // and typing in one note box updated the others as you typed.
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, rounds: [], flags: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          clips: [
            { id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 10000, endMs: 12000, kind: 'ghost_track', score: 0.5, detail: {} },
            { id: 2, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 20000, endMs: 22000, kind: 'ghost_track', score: 0.5, detail: {} },
            { id: 3, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 30000, endMs: 32000, kind: 'ghost_track', score: 0.5, detail: {} },
          ],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getAllByPlaceholderText('Review note')).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /Match #42/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Mark this round reviewed (3 clips)' })).toBeTruthy();

    fireEvent.input(screen.getByPlaceholderText('Review note'), { target: { value: 'heard the spawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this round' }));
    await waitFor(() => expect(mockAdmin.integrityReview).toHaveBeenCalledWith(42, 2, 1, 3, 'dismissed', 'heard the spawn'));
  });

  it('shows a clip whose round is already dismissed as visibly reviewed, with its note', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, flags: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          rounds: [integrityRound({ reviewState: 'dismissed', reviewNote: 'heard the spawn' })],
          clips: [{ id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {} }],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });

    await waitFor(() => expect(screen.getByText('dismissed: heard the spawn')).toBeTruthy());
    // Scoped to the evidence section: other sections have their own muted
    // ul.admin-list items (steam flags, cleared penalties) this could catch.
    const section = document.getElementById('evidence')!.closest('section')!;
    const li = section.querySelector('ul.admin-list > li.muted') as HTMLElement | null;
    expect(li).toBeTruthy();
    expect(within(li as HTMLElement).getByText('dismissed: heard the spawn')).toBeTruthy();
  });

  it('does not bleed review state or notes between two rounds differing only in slot', async () => {
    // The whole key is (matchId, ordinal, half, slot). A fixture with one round
    // cannot detect a future partial-key lookup that drops half or slot: it
    // would still match, and the test would still pass, while an admin was
    // shown that a moment had already been cleared when it had not.
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, flags: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          rounds: [
            integrityRound({ slot: 3, reviewState: 'dismissed', reviewNote: 'heard the spawn' }),
            integrityRound({ slot: 4, reviewState: 'new', reviewNote: '' }),
            integrityRound({ ordinal: 2, half: 2, slot: 3, reviewState: 'reviewed', reviewNote: 'second half note' }),
          ],
          clips: [
            { id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {} },
            { id: 2, matchId: 42, ordinal: 2, half: 1, slot: 4, startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {} },
            { id: 3, matchId: 42, ordinal: 2, half: 2, slot: 3, startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {} },
          ],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    await waitFor(() => expect(screen.getAllByPlaceholderText('Review note')).toHaveLength(3));

    // Exactly two of the three groups are triaged, and each carries its OWN note.
    // Scoped to the evidence section: the file has other ul.admin-list
    // elements (aliases, tickets, notes) that this selector would also match.
    const section = document.getElementById('evidence')!.closest('section')!;
    const groups = section.querySelectorAll('ul.admin-list > li');
    expect(groups).toHaveLength(3);
    expect((groups[0] as HTMLElement).className).toContain('muted');
    expect((groups[1] as HTMLElement).className).not.toContain('muted');
    expect((groups[2] as HTMLElement).className).toContain('muted');
    expect(within(groups[0] as HTMLElement).getByText('dismissed: heard the spawn')).toBeTruthy();
    expect(within(groups[2] as HTMLElement).getByText('reviewed: second half note')).toBeTruthy();
    expect(within(groups[1] as HTMLElement).queryByText(/heard the spawn|second half note/)).toBeNull();

    // Typing in the second group's note box leaves the others empty, and its
    // button posts its own slot rather than the first group's.
    const inputs = screen.getAllByPlaceholderText('Review note') as HTMLInputElement[];
    fireEvent.input(inputs[1], { target: { value: 'slot 4 only' } });
    expect(inputs[0].value).toBe('');
    expect(inputs[2].value).toBe('');
    fireEvent.click(within(groups[1] as HTMLElement).getByRole('button', { name: 'Mark this round reviewed (1 clip)' }));
    await waitFor(() => expect(mockAdmin.integrityReview).toHaveBeenCalledWith(42, 2, 1, 4, 'reviewed', 'slot 4 only'));
    expect(mockAdmin.integrityReview).toHaveBeenCalledTimes(1);
  });

  // The review POST triggers the same reload every other action on the file
  // uses; this pins that the new state actually reaches the screen from it,
  // not merely that the call went out.
  it('shows the review that was just posted without a manual reload', async () => {
    const base = file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, flags: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          rounds: [integrityRound()],
          clips: [{ id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {} }],
        },
      },
    });
    mockPeople.file.mockResolvedValueOnce(base).mockResolvedValueOnce({
      ...base,
      sections: {
        ...base.sections,
        evidence: {
          ...base.sections.evidence,
          rounds: [integrityRound({ reviewState: 'reviewed', reviewNote: 'checked it' })],
        },
      },
    });
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.queryByText(/reviewed: checked it/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mark this round reviewed (1 clip)' }));
    await waitFor(() => expect(screen.getByText('reviewed: checked it')).toBeTruthy());
  });

  it('offers a moderator the same evidence with no review buttons, but the same review state', async () => {
    mockPeople.file.mockResolvedValue(file({
      actions: ['note', 'looked_at', 'open_ticket'],
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, flags: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          rounds: [integrityRound({ reviewState: 'dismissed', reviewNote: 'heard the spawn' })],
          clips: [{ id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {} }],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000008" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.queryByRole('button', { name: /Mark this round reviewed/ })).toBeNull();
    // Mods see what admins see here; only the review buttons are admin-only.
    expect(screen.getByText('dismissed: heard the spawn')).toBeTruthy();
  });
});
