import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { AdminOverview, IntegrityClip, IntegrityPlayerRow, IntegrityRound } from '../api';

const { mockAdmin, mockApi } = vi.hoisted(() => ({
  mockAdmin: {
    players: vi.fn(), player: vi.fn(), ban: vi.fn(), overview: vi.fn(), settings: vi.fn(), saveSetting: vi.fn(),
    reports: vi.fn(), audit: vi.fn(),
    integrity: vi.fn(), integrityPlayer: vi.fn(), integrityReview: vi.fn(),
    integrityJob: vi.fn(), integrityRun: vi.fn(),
    campaigns: vi.fn(), uploadCampaign: vi.fn(), publishCampaign: vi.fn(),
    reinstallCampaign: vi.fn(), deleteCampaign: vi.fn(),
  },
  mockApi: { reportEligibility: vi.fn(), report: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin }, api: { ...actual.api, ...mockApi } };
});

const { Admin } = await import('./Admin');
const { QueuePanel } = await import('./Play');
const { ReportPlayer } = await import('../components/ReportPlayer');

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [...Object.values(mockAdmin), ...Object.values(mockApi)]) fn.mockReset();
  // The Integrity tab always asks for the analysis job's state, so every test
  // that opens it needs an answer whether or not it cares about one.
  mockAdmin.integrityJob.mockResolvedValue({
    available: true,
    job: { status: 'idle', mode: null, startedAt: null, finishedAt: null, exitCode: null, output: [] },
    pending: 0,
    matchInFlight: false,
  });
});

const me = { steamid: '1', name: 'boss', avatar: null, status: 'active', isAdmin: true };

describe('Admin page', () => {
  it('refuses a non-admin without calling the admin API', () => {
    render(<Admin session={{ kind: 'active', me: { ...me, isAdmin: false } }} />);
    expect(screen.getByText('Admins only.')).toBeTruthy();
    expect(mockAdmin.players).not.toHaveBeenCalled();
  });

  it('lists players, opens a detail and bans with a reason', async () => {
    const row = { steamid: '2', name: 'griefer', avatar: null, status: 'active', isAdmin: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 2 };
    mockAdmin.players.mockResolvedValue({ players: [row] });
    mockAdmin.player.mockResolvedValue({
      ...row, discordId: null, activeBan: null, bans: [], notes: [], matches: [], penalties: [], timeout: null, reportsAgainst: [],
    });
    mockAdmin.ban.mockResolvedValue({ ok: true });
    window.confirm = () => true;
    render(<Admin session={{ kind: 'active', me }} />);
    await waitFor(() => expect(screen.getByText('griefer')).toBeTruthy());
    fireEvent.click(screen.getByText('griefer'));
    await waitFor(() => expect(screen.getByPlaceholderText('Reason (shown to them)')).toBeTruthy());
    fireEvent.input(screen.getByPlaceholderText('Reason (shown to them)'), { target: { value: 'throwing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(mockAdmin.ban).toHaveBeenCalledWith('2', 'throwing', null));
  });

  it('settings tab shows grouped settings', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.settings.mockResolvedValue({
      settings: [{ key: 'ready_seconds', label: 'Ready check seconds', help: 'h', group: 'Queue', value: '120', type: { kind: 'int', min: 15, max: 600 } }],
      campaigns: [],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByText('Ready check seconds')).toBeTruthy());
    expect((screen.getByLabelText('Ready check seconds') as HTMLInputElement).value).toBe('120');
  });
});

describe('queue timeout', () => {
  it('disables Join queue and says when you can queue again', () => {
    const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    render(<QueuePanel count={2} joined={false} players={[]} refresh={() => {}} timeout={{ until, offenses: 2 }} />);
    expect((screen.getByRole('button', { name: 'Join queue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/queue again in/)).toBeTruthy();
  });
});

describe('ReportPlayer', () => {
  it('asks the server, then sends a report for a picked player and reason', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [{ steamid: '5', name: 'tino', alreadyReported: false }] });
    mockApi.report.mockResolvedValue({ ok: true });
    render(<ReportPlayer matchId={7} />);
    fireEvent.click(screen.getByText('Report a player'));
    await waitFor(() => expect(screen.getByLabelText('Player')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'afk' } });
    fireEvent.click(screen.getByText('Send report'));
    await waitFor(() => expect(mockApi.report).toHaveBeenCalledWith(7, '5', 'afk', ''));
    await waitFor(() => expect(screen.getByText(/An admin will look at it/)).toBeTruthy());
  });

  it('shows why reporting is closed', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: false, reason: 'reports close 48 hours after a match ends' });
    render(<ReportPlayer matchId={7} />);
    fireEvent.click(screen.getByText('Report a player'));
    await waitFor(() => expect(screen.getByText(/Reports close 48 hours/)).toBeTruthy());
  });
});

describe('AdminMatches layout', () => {
  const overview = (): AdminOverview => ({
    open: [{
      id: 40, campaign: 'death_toll', state: 'live', serverId: 1, connected: 8, rostered: 8,
      createdAt: '2026-09-18T05:28:36Z', wentLiveAt: '2026-09-18T05:28:37Z',
      connect: { host: '45.32.199.85', port: 27015, password: 'pug_ab12cd34' },
      forecast: {
        srA: 1400, srB: 1150, srGap: 250, muGap: 2.5,
        muA: 27.5, muB: 25, sigmaA: 6.5, sigmaB: 6.5,
        winProbA: 0.64, winProbB: 0.36,
        ratedA: 4, ratedB: 4, source: 'current',
      },
    }],
    recent: [],
    voided: [],
    servers: [{
      id: 1, name: 'Dallas', host: '45.32.199.85', port: 27015, status: 'live',
      enabled: 1, tvEnabled: 1, tvPort: 27020, tvPassword: 'dunged',
    }],
    queue: [{ steamid: '1', name: 'alice', avatar: null }],
  });

  const openTab = async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.overview.mockResolvedValue(overview());
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Matches' }));
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
  };

  it('shows the paper odds and the gap for a live match', async () => {
    await openTab();
    expect(screen.getByText('64%')).toBeTruthy();
    expect(screen.getByText(/250 SR to A/)).toBeTruthy();
  });

  // The real game server, not SourceTV: an admin joining to watch needs the
  // console line, and it is not on the match card because it is not theirs.
  it('gives an admin the console line for the real server', async () => {
    await openTab();
    expect(screen.getByText('password pug_ab12cd34; connect 45.32.199.85:27015')).toBeTruthy();
  });

  it('shows no connect line for a match with no server yet', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    const o = overview();
    o.open[0] = { ...o.open[0], state: 'configuring', serverId: null, connect: null };
    mockAdmin.overview.mockResolvedValue(o);
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Matches' }));
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
    expect(screen.queryByText(/connect 45.32/)).toBeNull();
  });

  // The bug this pins: a wide table with nowrap cells, unwrapped, grows past
  // its panel instead of scrolling inside it, and the last column renders
  // outside the panel border. Already fixed twice in this codebase (.teams and
  // .profile-grid both carry a comment about it) and missed on two of the
  // three tables on this tab.
  it('keeps every table inside a scroll wrapper so none can overflow its panel', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.overview.mockResolvedValue(overview());
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Matches' }));
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());

    const tables = [...container.querySelectorAll('table.admin-table')];
    expect(tables.length).toBeGreaterThanOrEqual(3);
    for (const t of tables) expect(t.closest('.table-wrap')).not.toBeNull();
  });
});

describe('AdminIntegrity', () => {
  const row = (over: Partial<IntegrityPlayerRow> = {}): IntegrityPlayerRow => ({
    steamid: '10', name: 'Tino', rounds: 5, clips: 2, fidMax: 0.9, fidP95: 0.4,
    occZ: 3.1, teamGap: 2.2, pFid: 0.95, pOcc: 0.9, pGap: 0.8, composite: 0.98, ...over,
  });

  const clip = (over: Partial<IntegrityClip> = {}): IntegrityClip => ({
    id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3,
    startMs: 5000, endMs: 7000, kind: 'ghost_track', score: 0.5, detail: {}, ...over,
  });

  const round = (over: Partial<IntegrityRound> = {}): IntegrityRound => ({
    matchId: 42, ordinal: 2, half: 1, slot: 3, campaign: 'farm',
    metrics: {
      fidMax: 0.5, fidP95: 0.3, occZ: null, teamRank: null, teamGap: null, eligiblePairs: 10,
      gates: { considered: 40, notLive: 5, notGhost: 10, inGrace: 5, tooClose: 5, occluded: 5, passed: 10 },
    },
    computedAt: '2026-09-17T00:00:00Z', reviewState: 'new', reviewNote: '', ...over,
  });

  const open = async (name = 'Tino') => {
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
    fireEvent.click(screen.getByText(name));
    await waitFor(() => expect(mockAdmin.integrityPlayer).toHaveBeenCalled());
  };

  const jobInfo = (over: Record<string, unknown> = {}) => ({
    available: true,
    job: { status: 'idle', mode: null, startedAt: null, finishedAt: null, exitCode: null, output: [] },
    pending: 0,
    matchInFlight: false,
    ...over,
  });

  /** Open the Integrity tab with the board empty, which is where the run
   *  controls matter most. */
  const openTab = async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [] });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
  };

  /** The column key shipped live and invisible for a day: it used `class="key"`,
   *  which the replay viewer's floating legend styles `position: absolute`, so
   *  the whole <details> was pulled out of its panel and left an empty box with
   *  no summary to click. Nothing failed; two stylesheets simply agreed on a
   *  name. This asserts the name stays distinct, since the symptom is invisible
   *  by construction and would not be noticed again. */
  it('keeps the column key off the replay viewer\'s .key class', async () => {
    await openTab();
    const summary = await waitFor(() => screen.getByText('What these columns mean'));
    const details = summary.closest('details');
    expect(details).toBeTruthy();
    expect(details!.classList.contains('key')).toBe(false);
    expect(details!.classList.contains('colkey')).toBe(true);
  });

  it('runs the analysis from the panel', async () => {
    mockAdmin.integrityJob.mockResolvedValue(jobInfo());
    mockAdmin.integrityRun.mockResolvedValue({});
    await openTab();
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Re-analyse all replays' }));
    fireEvent.click(btn);
    await waitFor(() => expect(mockAdmin.integrityRun).toHaveBeenCalledWith('full', false));
  });

  it('says how many rounds are waiting and that they are picked up automatically', async () => {
    mockAdmin.integrityJob.mockResolvedValue(jobInfo({ pending: 3 }));
    await openTab();
    await waitFor(() => expect(screen.getByText(/3 rounds waiting to be measured/)).toBeTruthy());
    expect(screen.getByText(/measured automatically once a match finishes/)).toBeTruthy();
  });

  // The guard that matters: this decodes every replay on disk on the same two
  // cores holding 100 tick.
  it('blocks the run while a match is in flight, and offers a deliberate force', async () => {
    mockAdmin.integrityJob.mockResolvedValue(jobInfo({ matchInFlight: true }));
    mockAdmin.integrityRun.mockResolvedValue({});
    await openTab();
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Re-analyse all replays' }));
    expect(btn).toHaveProperty('disabled', true);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Force' }));
    await waitFor(() => expect(mockAdmin.integrityRun).toHaveBeenCalledWith('full', true));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('shows the running output and offers no force while a run is going', async () => {
    mockAdmin.integrityJob.mockResolvedValue(jobInfo({
      matchInFlight: true,
      job: {
        status: 'running', mode: 'full', startedAt: '2026-09-18T05:00:00Z', finishedAt: null,
        exitCode: null, output: ['Priors: 17 maps seen', 'Analysed 198 rounds, skipped 0.'],
      },
    }));
    await openTab();
    await waitFor(() => expect(screen.getByText(/Analysed 198 rounds/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Analysing…' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Force' })).toBeNull();
  });

  it('says a failed run failed, with its exit code', async () => {
    mockAdmin.integrityJob.mockResolvedValue(jobInfo({
      job: {
        status: 'failed', mode: 'full', startedAt: '2026-09-18T05:00:00Z',
        finishedAt: '2026-09-18T05:01:00Z', exitCode: 1, output: ['Error: ENOENT'],
      },
    }));
    await openTab();
    await waitFor(() => expect(screen.getByText(/failed/)).toBeTruthy());
    expect(screen.getByText(/exit 1/)).toBeTruthy();
  });

  it('says so rather than offering a button when no replay directory exists', async () => {
    mockAdmin.integrityJob.mockResolvedValue({ available: false });
    await openTab();
    await waitFor(() => expect(screen.getByText(/No replay directory is configured/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Re-analyse all replays' })).toBeNull();
  });

  it('ranks the higher composite first and calls the number theoretical, not a verdict', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({
      players: [
        row(),
        row({ steamid: '20', name: 'PowerMustache', occZ: null, teamGap: null, fidMax: 0.2, fidP95: 0.1, pFid: 0.1, pOcc: null, pGap: null, composite: 0.1 }),
      ],
    });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('Tino')).toBeTruthy());

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    // The composite renders as a RANK inside a stated population, never as a
    // percentage. percentile() is below/(n-1), so the top row is exactly 1.0 by
    // construction: "Composite 100%" next to a real person's SteamID is a
    // number that reads as a verdict and is nothing of the kind.
    expect(within(rows[0] as HTMLElement).getByText('1 of 2')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('2 of 2')).toBeTruthy();
    expect(screen.queryByText('98%')).toBeNull();

    // A null occZ/pOcc/teamGap/pGap must render as "n/a", never as 0, since 0 would mean
    // "average" and null means "we don't know".
    expect(within(rows[1] as HTMLElement).getAllByText('n/a')).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getAllByText('(n/a)')).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).queryByText('0.00')).toBeNull();

    expect(screen.getByText(/theoretical/i)).toBeTruthy();
  });

  it('identifies people by name, falling back to the SteamID the server sent', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({
      players: [row(), row({ steamid: '76561198000000020', name: '76561198000000020' })],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('Tino')).toBeTruthy());
    expect(screen.getByText('76561198000000020')).toBeTruthy();
  });

  it('says so and dims the board when nobody has a clip at all', async () => {
    // A ranking with nothing flagged is a list of your best players by another
    // name, which decision 5 of the design names as the failure to avoid.
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({
      players: [row({ clips: 0 }), row({ steamid: '20', name: 'PowerMustache', clips: 0, composite: 0.1 })],
    });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('Tino')).toBeTruthy());
    expect(screen.getByText(/No clips have been flagged for anyone/)).toBeTruthy();
    expect(container.querySelector('.table-wrap.muted')).toBeTruthy();
  });

  it('leaves the board undimmed once anything is flagged', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row({ clips: 1 })] });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('Tino')).toBeTruthy());
    expect(screen.queryByText(/No clips have been flagged for anyone/)).toBeNull();
    expect(container.querySelector('.table-wrap.muted')).toBeNull();
  });

  it('opens a player to a clip that links to its match and shows the flagged moment', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row()] });
    mockAdmin.integrityPlayer.mockResolvedValue({
      rounds: [],
      clips: [clip({ ordinal: 1, slot: 0, startMs: 12000, endMs: 14000, score: 0.9 })],
    });
    await open();

    // Evidence, not a URL that doesn't exist: /match/:id is a real route, and
    // the clip's ordinal, half and start time ride along as query params so
    // MatchDetail can pick the round and seek the viewer straight to the
    // flagged moment instead of a reviewer scrubbing to it by hand.
    const link = await screen.findByRole('link', { name: /Match #42/ });
    expect(link.getAttribute('href')).toBe('/match/42?ordinal=1&half=1&t=12000');
    expect(screen.getByText(/fidelity 0\.90/)).toBeTruthy();
    expect(screen.getByText(/2\.0s/)).toBeTruthy();
  });

  it('puts ONE review control on a player-round, however many clips it holds', async () => {
    // Review state is keyed by the player-round, so a control per clip meant
    // clicking Reviewed on one six-second moment silently triaged up to five,
    // and typing in one note box updated the others as you typed.
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row()] });
    mockAdmin.integrityPlayer.mockResolvedValue({
      rounds: [round()],
      clips: [clip({ id: 1 }), clip({ id: 2, startMs: 20000, endMs: 22000 }), clip({ id: 3, startMs: 30000, endMs: 32000 })],
    });
    await open();
    await waitFor(() => expect(screen.getAllByPlaceholderText('Review note')).toHaveLength(1));
    expect(screen.getAllByRole('link', { name: /Match #42/ })).toHaveLength(3);
    // And the label says what the button actually does, so nobody clicks it
    // believing they settled only the clip they just watched.
    expect(screen.getByRole('button', { name: 'Mark this round reviewed (3 clips)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss this round (3 clips)' })).toBeTruthy();
  });

  it('marks a round Reviewed with the typed note, in the exact (matchId, ordinal, half, slot, state, note) order', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row()] });
    mockAdmin.integrityPlayer.mockResolvedValue({ rounds: [], clips: [clip()] });
    mockAdmin.integrityReview.mockResolvedValue({ ok: true });
    await open();
    await waitFor(() => expect(screen.getByPlaceholderText('Review note')).toBeTruthy());

    fireEvent.input(screen.getByPlaceholderText('Review note'), { target: { value: 'looked clean on rewatch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark this round reviewed (1 clip)' }));

    // Literals here are independent of the fixture above (matchId 42, ordinal 2, half 1,
    // slot 3 were typed fresh, not read back from a mock call), so a positional swap in
    // the component would show up as a mismatch here rather than trivially pass.
    await waitFor(() => expect(mockAdmin.integrityReview).toHaveBeenCalledWith(42, 2, 1, 3, 'reviewed', 'looked clean on rewatch'));
  });

  it('marks a round Dismissed with a different state string than Reviewed', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row()] });
    mockAdmin.integrityPlayer.mockResolvedValue({ rounds: [], clips: [clip()] });
    mockAdmin.integrityReview.mockResolvedValue({ ok: true });
    await open();
    await waitFor(() => expect(screen.getByPlaceholderText('Review note')).toBeTruthy());

    fireEvent.input(screen.getByPlaceholderText('Review note'), { target: { value: 'heard the spawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this round (1 clip)' }));

    await waitFor(() => expect(mockAdmin.integrityReview).toHaveBeenCalledWith(42, 2, 1, 3, 'dismissed', 'heard the spawn'));
  });

  it('shows a clip whose round is already dismissed as visibly reviewed, with its note', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row()] });
    mockAdmin.integrityPlayer.mockResolvedValue({
      rounds: [round({ reviewState: 'dismissed', reviewNote: 'heard the spawn' })],
      clips: [clip()],
    });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('Tino')).toBeTruthy());
    fireEvent.click(screen.getByText('Tino'));

    await waitFor(() => expect(screen.getByText('dismissed: heard the spawn')).toBeTruthy());
    const li = container.querySelector('li.muted') as HTMLElement | null;
    expect(li).toBeTruthy();
    expect(within(li as HTMLElement).getByText('dismissed: heard the spawn')).toBeTruthy();
  });

  it('does not bleed review state or notes between two rounds differing only in slot', async () => {
    // The whole key is (matchId, ordinal, half, slot). A fixture with one round
    // cannot detect a future partial-key lookup that drops half or slot: it
    // would still match, and the test would still pass, while an admin was
    // shown that a moment had already been cleared when it had not.
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({ players: [row()] });
    mockAdmin.integrityPlayer.mockResolvedValue({
      rounds: [
        round({ slot: 3, reviewState: 'dismissed', reviewNote: 'heard the spawn' }),
        round({ slot: 4, reviewState: 'new', reviewNote: '' }),
        round({ ordinal: 2, half: 2, slot: 3, reviewState: 'reviewed', reviewNote: 'second half note' }),
      ],
      clips: [
        clip({ id: 1, slot: 3 }),
        clip({ id: 2, slot: 4 }),
        clip({ id: 3, half: 2, slot: 3 }),
      ],
    });
    mockAdmin.integrityReview.mockResolvedValue({ ok: true });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('Tino')).toBeTruthy());
    fireEvent.click(screen.getByText('Tino'));
    await waitFor(() => expect(screen.getAllByPlaceholderText('Review note')).toHaveLength(3));

    // Exactly two of the three groups are triaged, and each carries its OWN note.
    const groups = container.querySelectorAll('ul.admin-list > li');
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
});

describe('AdminCampaigns', () => {
  // Every test here mounts <Admin>, which always mounts AdminPlayers first
  // (the default tab) and AdminCampaigns asks the same /api/admin/overview
  // the Matches tab does for its server list, so both need an answer before
  // the Campaigns tab is even reachable, whether or not a given test cares
  // about either response.
  const twoServers = [
    { id: 1, name: 'Dallas', host: 'h', port: 1, status: 'live', enabled: 1, tvPort: null, tvPassword: null, tvEnabled: 0 },
    { id: 2, name: 'Backup', host: 'h', port: 1, status: 'live', enabled: 1, tvPort: null, tvPassword: null, tvEnabled: 0 },
  ];
  beforeEach(() => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.overview.mockResolvedValue({ open: [], recent: [], voided: [], queue: [], servers: twoServers });
  });

  it('shows free disk space so an admin sees headroom before uploading', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [] });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    expect(await waitFor(() => screen.getByText(/11(\.0)? GB free/i))).toBeTruthy();
  });

  // Every chapter of a campaign shares its slug, so a list keyed on ch.slug
  // gives every <li> an identical, non-unique key; ch.ordinal is the thing
  // that actually varies per chapter within one campaign. Preact's own
  // reconciliation happens to still land on the right text here regardless
  // of which of the two keys these plain text rows use (verified by hand:
  // there is no per-node state or uncontrolled input for a stale key match
  // to corrupt), so this cannot be a regression test for the collision
  // itself. What it does check is the thing that is actually observable: a
  // multi-chapter campaign renders every chapter, each with its own display
  // name and ordinal-correct finale tag, in file order.
  it('lists every chapter of a multi-chapter campaign with its own display name and finale tag', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'dbd', name: 'DBD', state: 'published', enabled: 1,
        size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'dbd.vpk',
        uploaded_by: null, uploaded_at: 0, notes: null,
        chapters: [
          { slug: 'dbd', ordinal: 1, map: 'dbd1', display: 'Alley', is_finale: 0, included: 1, play_order: 1 },
          { slug: 'dbd', ordinal: 2, map: 'dbd2', display: 'Mall', is_finale: 0, included: 1, play_order: 2 },
          { slug: 'dbd', ordinal: 3, map: 'dbd3', display: 'Docks', is_finale: 1, included: 1, play_order: 3 },
        ],
        installs: [],
      }],
    });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    await waitFor(() => screen.getByText('Alley'));

    const rows = [...container.querySelectorAll('ol.admin-list li')].map((li) => li.textContent);
    expect(rows).toEqual(['Alley', 'Mall', 'Docksfinale']);
  });

  // The first real upload was a 372 MB file and the page looked frozen for
  // minutes, because nothing reported progress. This asserts the percentage
  // reaches the screen, not merely that the request was made.
  it('reports upload progress while the file is going out', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [] });
    let emit: ((f: number | null) => void) | undefined;
    let finish: (() => void) | undefined;
    mockAdmin.uploadCampaign.mockImplementation((_f: File, onProgress: (f: number | null) => void) => {
      emit = onProgress;
      return new Promise((resolve) => { finish = () => resolve({ slug: 'x', name: 'x', sizeBytes: 1, chapters: [] }); });
    });

    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    const input = await waitFor(() => screen.getByLabelText('Upload campaign'));
    const file = new File(['x'], 'c.vpk');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(emit).toBeTypeOf('function'));
    emit!(0.42);
    expect(await waitFor(() => screen.getByText(/Uploading 42%/))).toBeTruthy();

    // And it must clear when the upload finishes, or it reads as still running.
    finish!();
    await waitFor(() => expect(screen.queryByText(/Uploading 42%/)).toBeNull());
  });

  // A browser that will not report a total must not show a fake percentage.
  it('falls back to an indeterminate state with no total', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [] });
    let emit: ((f: number | null) => void) | undefined;
    mockAdmin.uploadCampaign.mockImplementation((_f: File, onProgress: (f: number | null) => void) => {
      emit = onProgress;
      return new Promise(() => {});
    });

    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    const input = await waitFor(() => screen.getByLabelText('Upload campaign'));
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'c.vpk')], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(emit).toBeTypeOf('function'));
    emit!(null);
    expect(await waitFor(() => screen.getByText(/Uploading\.\.\./))).toBeTruthy();
  });

  it('shows a per-server install state, and the error when one failed', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'dbd', name: 'DBD', state: 'published', enabled: 1,
        size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'dbd.vpk',
        uploaded_by: null, uploaded_at: 0, notes: null,
        chapters: [{ slug: 'dbd', ordinal: 1, map: 'dbd1', display: 'One', is_finale: 1, included: 1, play_order: 1 }],
        installs: [
          { slug: 'dbd', server_id: 1, state: 'installed', sha256: null, error: null, updated_at: 0 },
          { slug: 'dbd', server_id: 2, state: 'failed', sha256: null, error: 'connection refused', updated_at: 0 },
        ],
      }],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    expect(await waitFor(() => screen.getByText(/connection refused/))).toBeTruthy();
  });

  // There is no longer a checkbox here: installed-everywhere is the only
  // precondition, and the Settings tab is where a campaign enters the vote. The
  // panel still has to say which state it is in, because "cannot be voted for
  // yet" is the thing an admin needs to know.
  it('says a campaign with a failed install cannot be added to the vote', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'dbd', name: 'DBD', state: 'published', enabled: 0,
        size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'dbd.vpk',
        uploaded_by: null, uploaded_at: 0, notes: null, chapters: [],
        installs: [{ slug: 'dbd', server_id: 2, state: 'failed', sha256: null, error: 'x', updated_at: 0 }],
      }],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    expect(await waitFor(() => screen.getByText(/cannot be added to the vote/i))).toBeTruthy();
    // It must not claim the download is blocked, because it is not.
    expect(screen.getByText(/can still download/i)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  const draft = (over: Record<string, unknown> = {}) => ({
    slug: 'dbd', name: 'DBD', state: 'draft', enabled: 0,
    size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'dbd.vpk',
    uploaded_by: null, uploaded_at: 0, notes: null,
    chapters: [{ slug: 'dbd', ordinal: 1, map: 'dbd1', display: 'One', is_finale: 0, included: 1, play_order: 1 }],
    installs: [],
    ...over,
  });

  it('renders a draft with its parsed name editable and its chapters listed', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [draft()] });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    const input = await waitFor(() => screen.getByLabelText('Campaign name') as HTMLInputElement);
    expect(input.value).toBe('DBD');
    expect(screen.getByText('One')).toBeTruthy();
  });

  it('publishes with the slug and the current, possibly edited, name', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [draft()] });
    mockAdmin.publishCampaign.mockResolvedValue({ ok: true });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    const input = await waitFor(() => screen.getByLabelText('Campaign name'));
    fireEvent.input(input, { target: { value: 'Dead Before Dawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(mockAdmin.publishCampaign).toHaveBeenCalledWith('dbd', 'Dead Before Dawn'));
  });

  it('disables Publish when the name is empty or whitespace, so an empty-name publish cannot be submitted', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [draft()] });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    const input = await waitFor(() => screen.getByLabelText('Campaign name'));
    fireEvent.input(input, { target: { value: '   ' } });
    // Same toBeDisabled() unavailability as the pool-gate checkbox above.
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);
  });
});
