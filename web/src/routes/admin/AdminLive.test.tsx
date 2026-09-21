import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { LiveBoard, LiveBoardPlayer, LiveBoardStatus, LiveBoardReason } from '../../api';
import { ConfirmHost } from '../../components/Confirm';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { live: vi.fn(), overview: vi.fn(), leaveClock: vi.fn() },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { AdminLive } = await import('./AdminLive');
const { ApiError } = await import('../../api');

/** Stands in for the browser's WebSocket so a test can say "the hub just
 *  broadcast refresh" without a server. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close(): void {}
}

const player = (steamid: string, name: string, team: 'a' | 'b', status: LiveBoardStatus, reason: LiveBoardReason | null = null): LiveBoardPlayer =>
  ({ steamid, name, team, status, reason });

const board = (over: Partial<LiveBoard['matches'][number]> = {}): LiveBoard => ({
  now: '2026-09-21T20:10:00.000Z',
  holdMaxMinutes: 30,
  lowAlertSeconds: 90,
  matches: [{
    id: 81, campaign: 'no_mercy', map: 'l4d_hospital02_subway', state: 'paused', phase: 'paused',
    server: { id: 1, name: 'Dallas' }, teamAScore: 412, teamBScore: 380, elapsedS: 1325,
    spectate: null, leaveControl: 'ok', leaveTracking: true,
    teamA: [
      player('1', 'alice', 'a', { kind: 'connected', remainingS: null }),
      player('2', 'bob', 'a', { kind: 'dropped', sinceS: 42, remainingS: 258, held: false, holdLeftS: null }, { kind: 'signon_drop', at: '2026-09-21T20:09:00.000Z' }),
    ],
    teamB: [
      player('5', 'eve', 'b', { kind: 'never_connected', sincePopS: 200 }, { kind: 'not_in_voice' }),
      player('6', 'frank', 'b', { kind: 'connected', remainingS: 140 }),
    ],
    clocks: [{ kind: 'abandon', steamid: '2', name: 'bob', remainingS: 258, held: false, holdLeftS: null }],
    ...over,
  }],
});

const emptyOverview = { open: [], servers: [], recent: [], aborted: [], voided: [], queue: [], slowToReady: [] };

beforeEach(() => {
  for (const fn of Object.values(mockAdmin)) fn.mockReset();
  mockAdmin.live.mockResolvedValue(board());
  mockAdmin.overview.mockResolvedValue(emptyOverview);
  mockAdmin.leaveClock.mockResolvedValue({ ok: true, reply: 'PUGOK leave' });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/admin'); });

const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement;

describe('the live board', () => {
  it('says so when nothing is running', async () => {
    mockAdmin.live.mockResolvedValue({ ...board(), matches: [] });
    render(<AdminLive />);
    expect(await screen.findByText('No match is running.')).toBeTruthy();
  });

  it('shows the match line and one status per player', async () => {
    render(<AdminLive />);
    const card = (await screen.findByText(/#81/)).closest('section') as HTMLElement;
    expect(card.textContent).toContain('Dallas');
    expect(card.textContent).toContain('412 - 380');
    expect(card.textContent).toContain('paused');
    expect((within(card).getByRole('link', { name: '#81' }) as HTMLAnchorElement).getAttribute('href')).toBe('/match/81');

    expect((await row('alice')).textContent).toContain('On the server');
    expect((await row('bob')).textContent).toContain('Dropped 0:42 ago');
    expect((await row('bob')).textContent).toContain('4:18 left');
    expect((await row('bob')).textContent).toMatch(/rejected by the file check at \d/);
    expect((await row('eve')).textContent).toContain('Never connected, 3:20 since the pop');
    expect((await row('eve')).textContent).toContain('not in a voice channel');
    expect((await row('frank')).textContent).toContain('2:20 of reconnect time left');
  });

  it('holds a dropped player\'s clock in one click, with no dialog in the way', async () => {
    render(<><AdminLive /><ConfirmHost /></>);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'hold'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('adds five minutes', async () => {
    render(<AdminLive />);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: '+5 min' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'add', 300));
  });

  it('offers Release, and the ceiling, for a held clock', async () => {
    mockAdmin.live.mockResolvedValue(board({
      teamA: [player('2', 'bob', 'a', { kind: 'dropped', sinceS: 90, remainingS: 250, held: true, holdLeftS: 1700 })],
    }));
    render(<AdminLive />);
    const bob = await row('bob');
    expect(bob.textContent).toContain('on hold');
    expect(bob.textContent).toContain('releases itself in 28:20');
    expect(within(bob).queryByRole('button', { name: 'Hold' })).toBeNull();
    fireEvent.click(within(bob).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'release'));
  });

  it('asks, in the site\'s own dialog, before ending someone\'s time', async () => {
    render(<><AdminLive /><ConfirmHost /></>);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'End now' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    expect(dialog.textContent).toContain('End bob\'s reconnect time now?');
    expect(dialog.textContent).toContain('banned');
    expect(mockAdmin.leaveClock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'End now' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'end'));
  });

  it('lets an admin grant time to someone who is connected but has used some', async () => {
    render(<AdminLive />);
    fireEvent.click(within(await row('frank')).getByRole('button', { name: '+5 min' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '6', 'add', 300));
    expect(within(await row('alice')).queryByRole('button')).toBeNull();
  });

  it('disables the controls, and says why, on a server with an old plugin', async () => {
    mockAdmin.live.mockResolvedValue(board({ leaveControl: 'old_plugin' }));
    render(<AdminLive />);
    const bob = await row('bob');
    for (const name of ['Hold', '+5 min', 'End now']) {
      expect((within(bob).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/older than 0\.3\.4/)).toBeTruthy();
    fireEvent.click(within(bob).getByRole('button', { name: 'Hold' }));
    expect(mockAdmin.leaveClock).not.toHaveBeenCalled();
  });

  it('disables the clock controls, and says why, on a match that was started in game', async () => {
    // The plugin runs no reconnect clock for a self-started match, so every
    // one of these buttons would come back PUGERR. Say so before it is pressed.
    mockAdmin.live.mockResolvedValue(board({ leaveTracking: false }));
    render(<AdminLive />);
    const bob = await row('bob');
    for (const name of ['Hold', '+5 min', 'End now']) {
      expect((within(bob).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/started in game/)).toBeTruthy();
    fireEvent.click(within(bob).getByRole('button', { name: 'Hold' }));
    expect(mockAdmin.leaveClock).not.toHaveBeenCalled();
  });

  it('locks only the row being acted on, so one stuck request cannot grey out the other Hold', async () => {
    // Two players dropped on one match is exactly when this matters: an rcon
    // call against a slow box takes up to its timeout, and for that whole
    // window the second player's clock is running with no button to stop it.
    mockAdmin.live.mockResolvedValue(board({
      teamA: [
        player('2', 'bob', 'a', { kind: 'dropped', sinceS: 42, remainingS: 258, held: false, holdLeftS: null }),
        player('3', 'carol', 'a', { kind: 'dropped', sinceS: 20, remainingS: 100, held: false, holdLeftS: null }),
      ],
      teamB: [],
    }));
    mockAdmin.leaveClock.mockReturnValue(new Promise(() => {}));
    render(<AdminLive />);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'hold'));
    expect((within(await row('bob')).getByRole('button', { name: 'Hold' }) as HTMLButtonElement).disabled).toBe(true);

    const carol = within(await row('carol')).getByRole('button', { name: 'Hold' }) as HTMLButtonElement;
    expect(carol.disabled).toBe(false);
    fireEvent.click(carol);
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '3', 'hold'));
  });

  it('turns a countdown red at the threshold the admin feed warns at, not a number in the markup', async () => {
    // bob has 4:18 left: not low under the default 90 seconds, low under 300.
    mockAdmin.live.mockResolvedValue({ ...board(), lowAlertSeconds: 300 });
    render(<AdminLive />);
    const bob = await row('bob');
    expect(bob.querySelector('.live-row__left.is-low')).toBeTruthy();
    expect(document.querySelector('.live-clock.is-low')).toBeTruthy();
  });

  it('never goes red when the warning is turned off', async () => {
    mockAdmin.live.mockResolvedValue({ ...board(), lowAlertSeconds: 0 });
    render(<AdminLive />);
    const bob = await row('bob');
    expect(bob.querySelector('.live-row__left.is-low')).toBeNull();
    expect(document.querySelector('.live-clock.is-low')).toBeNull();
  });

  it('puts a failure on the card it happened on', async () => {
    mockAdmin.leaveClock.mockRejectedValue(new ApiError(502, 'could not reach Dallas: rcon connect timeout'));
    render(<AdminLive />);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'Hold' }));
    const card = (await screen.findByText(/#81/)).closest('section') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('could not reach Dallas: rcon connect timeout')).toBeTruthy());
  });

  it('keeps room for a sub action and builds nothing in it', async () => {
    render(<AdminLive />);
    const bob = await row('bob');
    const slot = bob.querySelector('.live-row__sub') as HTMLElement;
    expect(slot).toBeTruthy();
    expect(slot.children).toHaveLength(0);
  });

  it('fetches again when the hub says refresh, and not for the spectator feed', async () => {
    render(<AdminLive />);
    await screen.findByText(/#81/);
    expect(mockAdmin.live).toHaveBeenCalledTimes(1);
    FakeSocket.all[0].onmessage?.({ data: JSON.stringify({ event: 'live' }) });
    FakeSocket.all[0].onmessage?.({ data: JSON.stringify({ event: 'refresh' }) });
    await waitFor(() => expect(mockAdmin.live).toHaveBeenCalledTimes(2));
  });

  it('marks the card the admin feed linked to', async () => {
    history.replaceState(null, '', '/admin?live=81');
    render(<AdminLive />);
    const card = (await screen.findByText(/#81/)).closest('section') as HTMLElement;
    expect(card.className).toContain('is-target');
  });

  it('renders the servers, queue and recent results underneath', async () => {
    mockAdmin.overview.mockResolvedValue({
      ...emptyOverview,
      servers: [{ id: 1, name: 'Dallas', host: '1.2.3.4', port: 27015, status: 'live', enabled: 1, tvEnabled: 0, tvPort: null, tvPassword: null }],
      queue: [{ steamid: '9', name: 'queued', avatar: null }],
    });
    render(<AdminLive />);
    expect(await screen.findByRole('heading', { name: 'Servers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent results' })).toBeTruthy();
    expect(screen.getByText('queued')).toBeTruthy();
  });
});
