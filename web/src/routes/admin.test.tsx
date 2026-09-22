import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { AdminOverview, TicketDetail } from '../api';
import { ConfirmHost } from '../components/Confirm';

/** Click the affirmative button of the app's confirm dialog.
 *
 *  These used to stub window.confirm. The dialog is the app's own now, so the
 *  tests press it, which also means a broken dialog fails the tests that
 *  depend on it rather than passing on a stub.
 */
async function confirmDialog(name?: string | RegExp) {
  const dialog = await waitFor(() => screen.getByRole('alertdialog'));
  fireEvent.click(within(dialog).getByRole('button', { name: name ?? 'Confirm' }));
}

const { mockAdmin, mockApi, mockPeople, mockMod } = vi.hoisted(() => ({
  mockAdmin: {
    overview: vi.fn(), live: vi.fn(), leaveClock: vi.fn(), settings: vi.fn(), saveSetting: vi.fn(),
    audit: vi.fn(), serverLogSecret: vi.fn(), serverLogAuth: vi.fn(),
    integrityJob: vi.fn(),
    campaigns: vi.fn(), uploadCampaign: vi.fn(), publishCampaign: vi.fn(),
    reinstallCampaign: vi.fn(), deleteCampaign: vi.fn(), setMapsToPlay: vi.fn(),
  },
  mockApi: { reportEligibility: vi.fn(), report: vi.fn() },
  // The People desk is where a moderator lands, so a shell test reaches its
  // search screen even when it is testing the redirect and nothing else.
  mockPeople: { people: vi.fn(), review: vi.fn() },
  mockMod: { ticket: vi.fn(), contactReporter: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    adminApi: { ...actual.adminApi, ...mockAdmin },
    api: { ...actual.api, ...mockApi },
    peopleApi: { ...actual.peopleApi, ...mockPeople },
    modApi: { ...actual.modApi, ...mockMod },
  };
});

const { Admin } = await import('./Admin');
const { QueuePanel } = await import('./Play');
const { ReportPlayer } = await import('../components/ReportPlayer');
const { LocationProvider, Route, Router } = await import('preact-iso');
const { ADMIN_ROUTE_PATHS } = await import('./admin/adminRoutes');
const { Redirect } = await import('../components/Redirect');

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
beforeEach(() => {
  for (const fn of [...Object.values(mockAdmin), ...Object.values(mockApi), ...Object.values(mockPeople), ...Object.values(mockMod)]) fn.mockReset();
  mockPeople.people.mockResolvedValue({ players: [] });
  mockPeople.review.mockResolvedValue({ players: [], health: null });
  // The Integrity tab always asks for the analysis job's state, so every test
  // that opens it needs an answer whether or not it cares about one.
  mockAdmin.integrityJob.mockResolvedValue({
    available: true,
    job: { status: 'idle', mode: null, startedAt: null, finishedAt: null, exitCode: null, output: [] },
    pending: 0,
    matchInFlight: false,
  });
  // Live is the admin's landing tab now, so every render of <Admin> asks for
  // the board and the overview before any test has clicked anything. These
  // are the empty answers; a test that cares overrides them after this runs.
  mockAdmin.live.mockResolvedValue({ now: '2026-09-21T20:00:00.000Z', holdMaxMinutes: 30, matches: [] });
  mockAdmin.overview.mockResolvedValue({ open: [], servers: [], recent: [], aborted: [], voided: [], queue: [], slowToReady: [] });
  // Node has a global WebSocket and happy-dom does not replace it, so without
  // this the board's hub listener would dial ws://localhost from every test.
  vi.stubGlobal('WebSocket', undefined);
});

const me = { steamid: '1', name: 'boss', avatar: null, status: 'active', isAdmin: true };

/** Every screen in the panel is a URL now, so tests navigate rather than
 *  clicking a tab. ConfirmHost rides along: it renders nothing until an
 *  action asks a question. */
const renderAdmin = (path: string, session: Parameters<typeof Admin>[0]['session'] = { kind: 'active', me }) => {
  history.replaceState(null, '', path);
  return render(
    <LocationProvider>
      <Admin session={session} />
      <ConfirmHost />
    </LocationProvider>,
  );
};

describe('Admin page', () => {
  it('refuses a non-admin without calling the admin API', () => {
    renderAdmin('/admin/people', { kind: 'active', me: { ...me, isAdmin: false } });
    expect(screen.getByText('Staff only.')).toBeTruthy();
    expect(mockPeople.people).not.toHaveBeenCalled();
  });

  it('lands an admin on the live board, which is the first desk', async () => {
    renderAdmin('/admin/live');
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].textContent).toBe('Live');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No match is running.')).toBeTruthy();
    expect(mockPeople.people).not.toHaveBeenCalled();
  });

  it('does not offer the live board to a moderator', () => {
    renderAdmin('/admin/people', { kind: 'active', me: { ...me, isAdmin: false, isMod: true } });
    expect(screen.queryByRole('tab', { name: 'Live' })).toBeNull();
    expect(mockAdmin.live).not.toHaveBeenCalled();
  });

  it('settings tab shows grouped settings', async () => {
    mockAdmin.settings.mockResolvedValue({
      settings: [{ key: 'ready_seconds', label: 'Ready check seconds', help: 'h', group: 'Queue', value: '120', type: { kind: 'int', min: 15, max: 600 } }],
      campaigns: [],
    });
    renderAdmin('/admin/setup/settings');
    await waitFor(() => expect(screen.getByText('Ready check seconds')).toBeTruthy());
    expect((screen.getByLabelText('Ready check seconds') as HTMLInputElement).value).toBe('120');
  });

  it('says which servers are missing the mappack next to the campaign pool', async () => {
    mockAdmin.settings.mockResolvedValue({
      settings: [{ key: 'map_pool', label: 'Campaign pool', help: 'h', group: 'Queue', value: '["no_mercy"]', type: { kind: 'campaigns' } }],
      campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }],
      serversMissingDlc4: ['Chicago'],
    });
    renderAdmin('/admin/setup/settings');
    expect(await screen.findByText(/Chicago/)).toBeTruthy();
    expect(screen.getByText(/needs the L4D2 mappack/i)).toBeTruthy();
  });

  // A stale cached response, or a version-skew moment mid-deploy, can hand
  // the browser a settings payload built before serversMissingDlc4 existed.
  // The panel must degrade to "no notice", not take down every other
  // setting on the page.
  it('renders the campaign pool when the payload omits serversMissingDlc4 entirely', async () => {
    mockAdmin.settings.mockResolvedValue({
      settings: [{ key: 'map_pool', label: 'Campaign pool', help: 'h', group: 'Queue', value: '["no_mercy"]', type: { kind: 'campaigns' } }],
      campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }],
    });
    renderAdmin('/admin/setup/settings');
    await waitFor(() => expect(screen.getByText('Campaign pool')).toBeTruthy());
    expect(screen.getByText('No Mercy')).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText(/The moderators will look at it/)).toBeTruthy());
  });

  it('shows why reporting is closed', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: false, reason: 'reports close 48 hours after a match ends' });
    render(<ReportPlayer matchId={7} />);
    fireEvent.click(screen.getByText('Report a player'));
    await waitFor(() => expect(screen.getByText(/Reports close 48 hours/)).toBeTruthy());
  });
});

describe('the panels under the live board', () => {
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
    aborted: [],
    voided: [],
    servers: [{
      id: 1, name: 'Dallas', host: '45.32.199.85', port: 27015, status: 'live',
      enabled: 1, tvEnabled: 1, tvPort: 27020, tvPassword: 'dunged',
    }],
    queue: [{ steamid: '1', name: 'alice', avatar: null }],
    slowToReady: [],
  });

  const openTab = async () => {
    mockAdmin.overview.mockResolvedValue(overview());
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
  };

  // Log signing (audit 2026-09-21 item 15): the secret is set up from here,
  // and the counters are what an admin watches before flipping to enforce.
  it('offers to set up log signing on a server that has no secret', async () => {
    const o = overview();
    (o.servers[0] as Record<string, unknown>).logAuth = { mode: 'off', hasSecret: false, counters: null };
    mockAdmin.overview.mockResolvedValue(o);
    mockAdmin.serverLogSecret.mockResolvedValue({ ok: true, pushed: true, rotated: false });
    renderAdmin('/admin/live');
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    await confirmDialog('Generate and push');
    await waitFor(() => expect(mockAdmin.serverLogSecret).toHaveBeenCalledWith(1));
  });

  it('shows the signature counters and asks before enforcing', async () => {
    const o = overview();
    (o.servers[0] as Record<string, unknown>).logAuth = {
      mode: 'log', hasSecret: true,
      counters: { ok: 412, missing: 3, badMac: 1, replay: 0, lastOkAt: 1, lastFailAt: 1, lastFail: 'missing' },
    };
    mockAdmin.overview.mockResolvedValue(o);
    mockAdmin.serverLogAuth.mockResolvedValue({ ok: true });
    renderAdmin('/admin/live');
    expect(await screen.findByText(/ok 412 · unsigned 3 · bad 1 · replayed 0/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Log signing mode for Dallas'), { target: { value: 'enforce' } });
    await confirmDialog('Enforce');
    await waitFor(() => expect(mockAdmin.serverLogAuth).toHaveBeenCalledWith(1, 'enforce'));
  });

  // The index into what abandoned matches left behind. Without it an aborted
  // match is only reachable from a Discord post that scrolls away.
  it('lists aborted matches with the leaver and a link to the record', async () => {
    const o = overview();
    o.aborted = [{
      id: 80, campaign: 'no_mercy', endedAt: '2026-09-20T21:58:52Z',
      teamAScore: 181, teamBScore: 105, abandonedBy: 'mayhem',
    }];
    mockAdmin.overview.mockResolvedValue(o);
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
    expect(screen.getByText('Aborted')).toBeTruthy();
    expect(screen.getByText(/181 - 105/)).toBeTruthy();
    expect(screen.getByText(/left: mayhem/)).toBeTruthy();
    expect(screen.getByText('#80').closest('a')?.getAttribute('href')).toBe('/match/80');
  });

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

  // The pause ledger is for disputes: when one side says the other paused
  // them to death, the admin sees who paused, for how long, and on which map.
  it('lists each recent match\'s pauses with who and for how long', async () => {
    const o = overview();
    o.recent = [{
      id: 39, campaign: 'no_mercy', endedAt: '2026-09-18T04:00:00Z', teamAScore: 800, teamBScore: 600, winner: 'a', forecast: null,
      readyups: [],
      pauses: [
        { team: 'b', leave: false, mapOrdinal: 1, half: 2, startedAt: '2026-09-18 03:10:00', endedAt: '2026-09-18 03:11:30', seconds: 90 },
        { team: null, leave: true, mapOrdinal: 2, half: 1, startedAt: '2026-09-18 03:30:00', endedAt: '2026-09-18 03:30:20', seconds: 20 },
      ],
    }];
    mockAdmin.overview.mockResolvedValue(o);
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
    expect(screen.getByText('Team B 1:30 on map 2')).toBeTruthy();
    expect(screen.getByText('Reconnect 0:20 on map 3')).toBeTruthy();
  });

  it('lists each recent match\'s ready-ups with how long and who readied last', async () => {
    const o = overview();
    o.recent = [{
      id: 39, campaign: 'no_mercy', endedAt: '2026-09-18T04:00:00Z', teamAScore: 800, teamBScore: 600, winner: 'a', forecast: null,
      pauses: [],
      readyups: [
        { mapOrdinal: 0, half: 1, startedAt: '2026-09-18 03:00:00', endedAt: '2026-09-18 03:02:10', seconds: 130,
          lastUnready: ['76561198000000001'], lastUnreadyNames: ['killshot'],
          players: [{ steamid: '76561198000000001', name: 'killshot', seconds: 130 }] },
        { mapOrdinal: 1, half: 1, startedAt: '2026-09-18 03:20:00', endedAt: '2026-09-18 03:20:25', seconds: 25,
          lastUnready: [], lastUnreadyNames: [], players: [] },
      ],
    }];
    mockAdmin.overview.mockResolvedValue(o);
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
    expect(screen.getByText('2:10 on map 1, last killshot')).toBeTruthy();
    expect(screen.getByText('0:25 on map 2')).toBeTruthy();
  });

  it('shows the slow-to-ready table so a repeat offender stands out', async () => {
    const o = overview();
    o.slowToReady = [
      { steamid: '76561198000000001', name: 'killshot', readyups: 6, timesLast: 5, totalSeconds: 600, avgSeconds: 100 },
      { steamid: '76561198000000002', name: 'goober', readyups: 4, timesLast: 0, totalSeconds: 40, avgSeconds: 10 },
    ];
    mockAdmin.overview.mockResolvedValue(o);
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
    expect(screen.getByText('Slow to ready')).toBeTruthy();
    const row = screen.getByText('killshot').closest('tr')!;
    expect(row.textContent).toContain('5 of 6');
    expect(row.textContent).toContain('1:40');
    expect(row.textContent).toContain('10:00');
  });

  it('shows no connect line for a match with no server yet', async () => {
    const o = overview();
    o.open[0] = { ...o.open[0], state: 'configuring', serverId: null, connect: null };
    mockAdmin.overview.mockResolvedValue(o);
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
    expect(screen.queryByText(/connect 45.32/)).toBeNull();
  });

  // The bug this pins: a wide table with nowrap cells, unwrapped, grows past
  // its panel instead of scrolling inside it, and the last column renders
  // outside the panel border. Already fixed twice in this codebase (.teams and
  // .profile-grid both carry a comment about it) and missed on two of the
  // three tables on this tab.
  it('keeps every table inside a scroll wrapper so none can overflow its panel', async () => {
    mockAdmin.overview.mockResolvedValue(overview());
    const { container } = renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());

    const tables = [...container.querySelectorAll('table.admin-table')];
    expect(tables.length).toBeGreaterThanOrEqual(3);
    for (const t of tables) expect(t.closest('.table-wrap')).not.toBeNull();
  });
});

describe('AdminCampaigns', () => {
  // AdminCampaigns asks the same /api/admin/overview the Live desk does for
  // its server list, so it needs an answer before the Campaigns tab is even
  // reachable, whether or not a given test cares about the response.
  const twoServers = [
    { id: 1, name: 'Dallas', host: 'h', port: 1, status: 'live', enabled: 1, tvPort: null, tvPassword: null, tvEnabled: 0 },
    { id: 2, name: 'Backup', host: 'h', port: 1, status: 'live', enabled: 1, tvPort: null, tvPassword: null, tvEnabled: 0 },
  ];
  beforeEach(() => {
    mockAdmin.overview.mockResolvedValue({ open: [], recent: [], voided: [], queue: [], servers: twoServers });
  });

  it('shows free disk space so an admin sees headroom before uploading', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [] });
    renderAdmin('/admin/setup/campaigns');
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
        installs: [], mapsToPlay: null, maps: ['dbd1', 'dbd2', 'dbd3'], stock: false,
      }],
    });
    const { container } = renderAdmin('/admin/setup/campaigns');
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

    renderAdmin('/admin/setup/campaigns');
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

    renderAdmin('/admin/setup/campaigns');
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
        mapsToPlay: null, maps: ['dbd1'], stock: false,
      }],
    });
    renderAdmin('/admin/setup/campaigns');
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
        mapsToPlay: null, maps: [], stock: false,
      }],
    });
    renderAdmin('/admin/setup/campaigns');
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
    renderAdmin('/admin/setup/campaigns');
    const input = await waitFor(() => screen.getByLabelText('Campaign name') as HTMLInputElement);
    expect(input.value).toBe('DBD');
    expect(screen.getByText('One')).toBeTruthy();
  });

  it('publishes with the slug and the current, possibly edited, name', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [draft()] });
    mockAdmin.publishCampaign.mockResolvedValue({ ok: true });
    renderAdmin('/admin/setup/campaigns');
    const input = await waitFor(() => screen.getByLabelText('Campaign name'));
    fireEvent.input(input, { target: { value: 'Dead Before Dawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(mockAdmin.publishCampaign).toHaveBeenCalledWith('dbd', 'Dead Before Dawn'));
  });

  it('disables Publish when the name is empty or whitespace, so an empty-name publish cannot be submitted', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [draft()] });
    renderAdmin('/admin/setup/campaigns');
    const input = await waitFor(() => screen.getByLabelText('Campaign name'));
    fireEvent.input(input, { target: { value: '   ' } });
    // Same toBeDisabled() unavailability as the pool-gate checkbox above.
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);
  });

  const fiveMapCampaign = (over: Record<string, unknown> = {}) => ({
    slug: 'five', name: 'Five', state: 'published', enabled: 1,
    size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'five.vpk',
    uploaded_by: null, uploaded_at: 0, notes: null,
    chapters: [1, 2, 3, 4, 5].map((n) => ({
      slug: 'five', ordinal: n, map: `m${n}`, display: null,
      is_finale: n === 5 ? 1 : 0, included: 1, play_order: n,
    })),
    installs: [], mapsToPlay: null, maps: ['m1', 'm2', 'm3', 'm4', 'm5'], stock: false,
    ...over,
  });

  it('describes the unconfigured default as every map but the last', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [fiveMapCampaign()] });
    renderAdmin('/admin/setup/campaigns');
    const select = await waitFor(() => screen.getByLabelText('Maps to play') as HTMLSelectElement);
    expect(select.value).toBe('');
    expect(screen.getByText(/Default \(4 maps, no finale\)/)).toBeTruthy();
  });

  it('calls setMapsToPlay when an admin picks how many maps to play', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [fiveMapCampaign()] });
    mockAdmin.setMapsToPlay.mockResolvedValue({ ok: true });
    renderAdmin('/admin/setup/campaigns');
    const select = await waitFor(() => screen.getByLabelText('Maps to play'));
    fireEvent.change(select, { target: { value: '5' } });
    await waitFor(() => expect(mockAdmin.setMapsToPlay).toHaveBeenCalledWith('five', 5));
  });

  it('renders a stock campaign with a maps-to-play control but no reinstall or delete', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'no_mercy', name: 'No Mercy', state: 'published', enabled: 1,
        size_bytes: 0, sha256: '', vpk_filename: '',
        uploaded_by: null, uploaded_at: 0, notes: null,
        chapters: [], installs: [], mapsToPlay: null,
        maps: ['l4d_vs_hospital01_apartment', 'l4d_vs_hospital02_subway', 'l4d_vs_hospital03_sewers',
          'l4d_vs_hospital04_interior', 'l4d_vs_hospital05_rooftop'],
        stock: true,
      }],
    });
    renderAdmin('/admin/setup/campaigns');
    await waitFor(() => screen.getByText('No Mercy'));
    expect(screen.getByLabelText('Maps to play')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reinstall' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  // The spec asks for a stock campaign's card to list its chapters like a
  // custom one does, so an admin choosing "3 maps" can see which three. The
  // backend now fills `chapters` for the stock four once MISSIONS_DIR is
  // configured; this is the card actually rendering that data instead of
  // discarding it the way the registry's plain maps: string[] does.
  it('lists a stock campaign\'s chapters by name', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'dead_air', name: 'Dead Air', state: 'published', enabled: 1,
        size_bytes: 0, sha256: '', vpk_filename: '',
        uploaded_by: null, uploaded_at: 0, notes: null,
        chapters: [
          { slug: 'dead_air', ordinal: 0, map: 'l4d_vs_airport01_greenhouse', display: 'The Greenhouse', is_finale: 0, included: 1, play_order: null },
          { slug: 'dead_air', ordinal: 1, map: 'l4d_vs_airport02_offices', display: 'The Crane', is_finale: 1, included: 1, play_order: null },
        ],
        installs: [], mapsToPlay: null,
        maps: ['l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices'],
        stock: true,
      }],
    });
    renderAdmin('/admin/setup/campaigns');
    await waitFor(() => screen.getByText('Dead Air'));
    expect(screen.getByText('The Greenhouse')).toBeTruthy();
    expect(screen.getByText('The Crane')).toBeTruthy();
  });
});

describe('the panel shell', () => {
  const asMod = { kind: 'active' as const, me: { ...me, isAdmin: false, isMod: true } };

  it('lands an admin on Live and a moderator on People', async () => {
    renderAdmin('/admin');
    await waitFor(() => expect(location.pathname).toBe('/admin/live'));
    cleanup();
    renderAdmin('/admin', asMod);
    await waitFor(() => expect(location.pathname).toBe('/admin/people'));
  });

  it('keeps a moderator out of the other two desks, and off their APIs', async () => {
    renderAdmin('/admin/setup/settings', asMod);
    await waitFor(() => expect(location.pathname).toBe('/admin/people'));
    expect(mockAdmin.settings).not.toHaveBeenCalled();
    cleanup();
    renderAdmin('/admin/live', asMod);
    await waitFor(() => expect(location.pathname).toBe('/admin/people'));
    expect(mockAdmin.live).not.toHaveBeenCalled();
    expect(mockAdmin.overview).not.toHaveBeenCalled();
  });

  // The low-allowance post in the admin feed is this link, and the card it
  // names is the whole reason anyone clicks it.
  it('carries an old feed link to a card over to the board', async () => {
    renderAdmin('/admin?live=81');
    await waitFor(() => expect(location.pathname + location.search).toBe('/admin/live?live=81'));
  });

  it('says so for a URL that is not a screen', async () => {
    for (const url of ['/admin/people/nonsense', '/admin/setup/nonsense', '/admin/servers']) {
      renderAdmin(url);
      expect(await screen.findByText('No such page in the panel.'), url).toBeTruthy();
      cleanup();
    }
  });

  // The analysis panel asks an admin-only endpoint. The shell knows who is
  // looking, so it is the shell that keeps a moderator off it.
  it('leaves the analysis panel off a moderator\'s Needs a look', async () => {
    mockPeople.review.mockResolvedValue({ players: [], health: null });
    renderAdmin('/admin/people/review', asMod);
    expect(await screen.findByText('Nothing is waiting to be looked at.')).toBeTruthy();
    expect(mockAdmin.integrityJob).not.toHaveBeenCalled();
  });

  // Desks and sections are links, not buttons: a real href can be opened in
  // a new tab and copied out of the address bar, which is the point of
  // putting every screen on a URL.
  it('moves between desks by following a link', async () => {
    mockAdmin.settings.mockResolvedValue({ settings: [], campaigns: [] });
    renderAdmin('/admin/live');
    const setup = screen.getByRole('tab', { name: 'Setup' });
    expect(setup.tagName).toBe('A');
    expect(setup.getAttribute('href')).toBe('/admin/setup');
    fireEvent.click(setup);
    await waitFor(() => expect(location.pathname).toBe('/admin/setup'));
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  });

  // The bug this pins: with only <Route path="/admin">, every deep link in
  // the panel lands on the site's 404.
  it('mounts at a deep URL through the routes main.tsx declares', async () => {
    mockAdmin.audit.mockResolvedValue({ actions: [] });
    history.replaceState(null, '', '/admin/setup/audit');
    render(
      <LocationProvider>
        <Router>
          {ADMIN_ROUTE_PATHS.map((p) => <Route key={p} path={p} component={Admin} session={{ kind: 'active', me }} />)}
          <Route default component={() => <p>Page not found</p>} />
        </Router>
      </LocationProvider>,
    );
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Audit' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  // The component only. That the site still routes /bans through it is
  // asserted against the real route table, in appRoutes.test.tsx.
  it('sends a moved URL on and renders nothing', async () => {
    history.replaceState(null, '', '/bans');
    const { container } = render(<LocationProvider><Redirect to="/admin/people/bans" /></LocationProvider>);
    await waitFor(() => expect(location.pathname).toBe('/admin/people/bans'));
    expect(container.textContent).toBe('');
  });
});

describe('AdminTicket, reached by routing', () => {
  const caseFile = {
    steamid: '76561198000000011', name: 'Bone Breaker', avatar: null, status: 'active' as const, sr: null, games: 2,
    createdAt: '2026-08-18T01:35:32.000Z', activeBan: null, bans: [], penalties: [],
    timeout: null, inputFlags: [], aliases: [], sharesAddressWith: [],
    tickets: [
      { id: 1, targetId: '76561198000000011', targetDiscordId: null, targetName: 'Bone Breaker', status: 'open' as const, outcome: null,
        restricted: false, claimedBy: null, claimedByName: null, reports: 1, reporters: 1,
        categories: ['cheating'], createdAt: '2026-09-21T18:56:13.000Z', lastReportAt: null, closedAt: null },
      { id: 2, targetId: '76561198000000011', targetDiscordId: null, targetName: 'Bone Breaker', status: 'open' as const, outcome: null,
        restricted: false, claimedBy: null, claimedByName: null, reports: 1, reporters: 1,
        categories: ['toxicity'], createdAt: '2026-08-30T10:00:00.000Z', lastReportAt: null, closedAt: null },
    ],
  };

  const ticketDetail = (id: 1 | 2): TicketDetail => ({
    discussion: { state: 'unconfigured', surface: null, url: null },
    ticket: {
      id, targetId: '76561198000000011', targetDiscordId: null, targetName: 'Bone Breaker', status: 'open',
      outcome: null, restricted: false, claimedBy: null, claimedByName: null,
      reports: 1, reporters: 1, categories: id === 1 ? ['cheating'] : ['toxicity'],
      createdAt: '2026-09-21T18:56:13.000Z', lastReportAt: null, closedAt: null,
      outcomeNote: '', openedBy: null, openedByName: null, closedBy: null, closedByName: null,
    },
    reports: id === 1 ? [{
      id: 10, category: 'cheating', text: 'aimbot', reporterId: '76561198000000022', reporterDiscordId: null,
      reporterName: 'Reporter One', matchId: null, campaign: null, moment: null, createdAt: '2026-09-21T18:56:13.000Z',
    }] : [],
    events: [], bans: [], discordSanctions: [], access: [], accessCandidates: [], messages: [],
    caseFile, summary: null, viewer: { isAdmin: true, banCapMinutes: null },
  });

  // Pins the bug: AdminTicket rendered without a key kept its component state
  // (the chat link, the closing note) across an onOpen navigation to a
  // different ticket, so ticket B showed ticket A's "Open the chat with the
  // reporter in Discord" link and leftover note text.
  it('clears chat link and closing note when moving to a different ticket via Earlier tickets', async () => {
    mockMod.ticket.mockImplementation((id: number) => Promise.resolve(ticketDetail(id === 1 ? 1 : 2)));
    mockMod.contactReporter.mockResolvedValue({ ok: true, url: 'https://discord.com/channels/1/2/3' });

    renderAdmin('/admin/people/tickets/1');
    await waitFor(() => expect(screen.getByText('#1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Contact reporter' }));
    await waitFor(() => expect(screen.getByText('Open the chat with the reporter in Discord')).toBeTruthy());
    fireEvent.input(screen.getByLabelText('Closing note'), { target: { value: 'leftover note' } });
    expect((screen.getByLabelText('Closing note') as HTMLInputElement).value).toBe('leftover note');

    fireEvent.click(screen.getByRole('button', { name: '#2' }));
    await waitFor(() => expect(screen.getByText('#2')).toBeTruthy());
    expect(screen.queryByText('Open the chat with the reporter in Discord')).toBeNull();
    expect((screen.getByLabelText('Closing note') as HTMLInputElement).value).toBe('');
  });
});
