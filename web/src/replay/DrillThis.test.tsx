import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DrillActor, DrillSpec, PracticeLease } from '../api';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { createDrill: vi.fn(), startPractice: vi.fn(), practiceParks: vi.fn(), practiceLease: vi.fn(), loadDrillOnLease: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { DrillThis, actorHealth } = await import('./DrillThis');
const { ApiError } = await import('../api');

function actor(over: Partial<DrillActor> = {}): DrillActor {
  return {
    side: 'survivor', cls: 'zoey', name: 'mayhem', x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    vx: 0, vy: 0, vz: 0, health: 64, temp: 0, alive: true, ghost: false, incap: false,
    weapon: 'autoshotgun', clip: 8, reserve: 90, items: [], ...over,
  };
}

const LEASE = (over: Partial<PracticeLease> = {}): PracticeLease => ({
  id: 7, kind: 'drill', server: 'Riverside #4', owner: { steamid: '1', name: 'me' }, isOwner: true, canEnd: true,
  drillCode: 'K7QX', createdAt: '', readyAt: '', setupPhase: null, endsAt: new Date(Date.now() + 3_600_000).toISOString(), humans: 0,
  capacity: null, map: null, warnedAt: null, state: 'ready', endReason: null, endedAt: null,
  connect: { host: '66.59.208.5', port: 27016, password: 'abcd2345' }, ...over,
});

const SPEC: DrillSpec = {
  code: 'K7QX', version: 1, map: 'l4d_vs_hospital03_sewers',
  title: 'Match 212, No Mercy 3, round 2 at 12:38',
  source: { matchId: 212, ordinal: 2, half: 2, tMs: 758000 },
  actors: [
    actor(),
    actor({ name: '', cls: 'bill', health: 40, temp: 12 }),
    actor({ side: 'infected', cls: 'hunter', name: 'walls', health: 250, ghost: true, weapon: '' }),
  ],
  entities: [{ kind: 'witch', x: 0, y: 0, z: 0, health: 1000 }, { kind: 'tank', x: 0, y: 0, z: 0, health: 6400 }],
};

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.practiceParks.mockResolvedValue({ available: true, parks: [], mine: null });
});

const props = (over: Partial<Parameters<typeof DrillThis>[0]> = {}) => ({
  matchId: 212, ordinal: 2, half: 2, momentRef: { current: 758040.6 }, signedIn: true, ...over,
});

describe('DrillThis', () => {
  it('posts the moment on screen and shows the code, the line to type and who is where', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    expect(mockApi.createDrill).toHaveBeenCalledWith({ matchId: 212, ordinal: 2, half: 2, tMs: 758041 });
    expect(await screen.findByLabelText('Drill code K7QX')).toBeTruthy();
    expect(screen.getByText('K7QX').textContent).toBe('K7QX');
    expect(screen.getByText(/in any practice server/).textContent).toBe('Or type !drill K7QX in any practice server');
    expect(screen.getByText(SPEC.title)).toBeTruthy();
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([
      'SurvivorZoeymayhem64 HP',
      'SurvivorBillbot40+12 HP',
      'InfectedHunterwalls250 HP, ghost',
    ]);
    expect(screen.getByText(/Also:/).textContent).toBe('Also: Witch (1000 HP), AI Tank (6400 HP)');
  });

  it('copies the chat command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('!drill K7QX');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('asks a signed-out viewer to log in without calling the server', () => {
    render(<DrillThis {...props({ signedIn: false })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    const link = screen.getByRole('link', { name: 'Log in to start a drill server' });
    expect(link.getAttribute('href')!.startsWith('/auth/steam?next=')).toBe(true);
    // A backend route: without _top the SPA router swallows the click.
    expect(link.getAttribute('target')).toBe('_top');
    expect(mockApi.createDrill).not.toHaveBeenCalled();
  });

  it('treats an expired session like being signed out', async () => {
    mockApi.createDrill.mockRejectedValue(new ApiError(401, 'not logged in'));
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    expect(await screen.findByRole('link', { name: 'Log in to start a drill server' })).toBeTruthy();
  });

  it('shows the server\'s own reason when it refuses', async () => {
    mockApi.createDrill.mockRejectedValue(new ApiError(429, 'You can make 20 drills an hour; try again later.'));
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You can make 20 drills an hour; try again later.');
    // Still pressable, to try again.
    expect(screen.getByRole('button', { name: 'Drill this' })).toBeTruthy();
  });

  it('says so while the drill is being made', async () => {
    let resolve!: (v: unknown) => void;
    mockApi.createDrill.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    const busy = screen.getByRole('button', { name: 'Making drill...' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    resolve({ code: 'K7QX', spec: SPEC });
    await screen.findByLabelText('Drill code K7QX');
  });

  it('drops the code when the round switches, and when hidden', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    const { rerender } = render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    await screen.findByLabelText('Drill code K7QX');
    rerender(<DrillThis {...props({ half: 1 })} />);
    await waitFor(() => expect(screen.queryByLabelText('Drill code K7QX')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    await screen.findByLabelText('Drill code K7QX');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByLabelText('Drill code K7QX')).toBeNull();
  });

  it('without a drill server of your own: leads with Start a drill server, then shows its way in', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    mockApi.startPractice.mockResolvedValue({ joined: false, lease: LEASE({ state: 'setting_up', setupPhase: 'resetting' }) });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    const start = await screen.findByRole('button', { name: 'Start a drill server' });
    // The code is the secondary way in, and full size while nothing is leased.
    expect(screen.getByLabelText('Drill code K7QX').classList.contains('drill__code--small')).toBe(false);
    fireEvent.click(start);
    expect(mockApi.startPractice).toHaveBeenCalledWith({ kind: 'drill', drillCode: 'K7QX' });
    // The server restarts first, and says so: connecting during that drops you.
    expect((await screen.findByRole('status')).textContent)
      .toBe('Resetting Riverside #4 for a clean start, which takes up to a minute. Connect once it is loading.');
    expect(screen.getByText('password abcd2345; connect 66.59.208.5:27016')).toBeTruthy();
    expect(screen.getByText('abcd2345')).toBeTruthy();
    expect(screen.getByText(`${location.origin}/practice/7`)).toBeTruthy();
    expect(screen.getByLabelText('Drill code K7QX').classList.contains('drill__code--small')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Start a drill server' })).toBeNull();
  });

  it('where practice servers are not open to the viewer: the code alone, no server button', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    mockApi.practiceParks.mockResolvedValue({ available: false, parks: [], mine: null });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    await waitFor(() => expect(screen.getByText(/in a practice server/).textContent).toBe('Type !drill K7QX in a practice server'));
    expect(screen.queryByRole('button', { name: 'Start a drill server' })).toBeNull();
    expect(screen.queryByText(/Checking for a practice server/)).toBeNull();
  });

  it('says why no drill server could be started, and lets you try again', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    mockApi.startPractice.mockRejectedValue(new ApiError(503, 'All servers are busy with PUGs right now. Try again in a few minutes.'));
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start a drill server' }));
    expect((await screen.findByRole('alert')).textContent).toBe('All servers are busy with PUGs right now. Try again in a few minutes.');
    expect(screen.getByRole('button', { name: 'Start a drill server' })).toBeTruthy();
  });

  it('with a drill server of your own: leads with Load this drill on your server and shows its way in', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    mockApi.practiceParks.mockResolvedValue({ available: true, parks: [], mine: { id: 7, kind: 'drill' } });
    mockApi.practiceLease.mockResolvedValue(LEASE());
    mockApi.loadDrillOnLease.mockResolvedValue(LEASE({ drillCode: 'K7QX' }));
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    const load = await screen.findByRole('button', { name: 'Load this drill on your server' });
    expect(screen.queryByRole('button', { name: 'Start a drill server' })).toBeNull();
    expect(screen.getByText('password abcd2345; connect 66.59.208.5:27016')).toBeTruthy();
    fireEvent.click(load);
    expect(mockApi.loadDrillOnLease).toHaveBeenCalledWith(7, 'K7QX');
    expect((await screen.findByRole('status')).textContent).toBe('Sent to Riverside #4. The drill loads in a few seconds.');
    expect(screen.getByLabelText('Drill code K7QX').classList.contains('drill__code--small')).toBe(true);
  });

  it('a Practice Park never counts as your server: the panel offers a drill server', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    mockApi.practiceParks.mockResolvedValue({ available: true, parks: [], mine: { id: 3, kind: 'park' } });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    expect(await screen.findByRole('button', { name: 'Start a drill server' })).toBeTruthy();
    expect(mockApi.practiceLease).not.toHaveBeenCalled();
  });

  it('with a Hunter Training server of your own: says to close it first, links to it, offers no drill server', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    mockApi.practiceParks.mockResolvedValue({ available: true, parks: [], hunters: [], mine: { id: 7, kind: 'hunter' } });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    const link = await screen.findByRole('link', { name: 'your Hunter Training server' });
    expect(link.getAttribute('href')).toBe('/practice/7');
    expect(screen.queryByRole('button', { name: 'Start a drill server' })).toBeNull();
    expect(mockApi.practiceLease).not.toHaveBeenCalled();
  });

  it('in theater\'s panel: drills at once, and its Close empties and closes the panel', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: SPEC });
    const onHide = vi.fn();
    render(<DrillThis {...props()} autoStart onHide={onHide} />);
    expect(mockApi.createDrill).toHaveBeenCalledTimes(1);
    await screen.findByLabelText('Drill code K7QX');
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onHide).toHaveBeenCalled();
  });

  it('in theater\'s panel: an error still has a way out', async () => {
    mockApi.createDrill.mockRejectedValue(new ApiError(429, 'slow down'));
    const onHide = vi.fn();
    render(<DrillThis {...props()} autoStart onHide={onHide} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onHide).toHaveBeenCalled();
  });

  it('says when nobody was alive', async () => {
    mockApi.createDrill.mockResolvedValue({ code: 'K7QX', spec: { ...SPEC, actors: [], entities: [] } });
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    expect(await screen.findByText('Nobody was alive at this moment.')).toBeTruthy();
  });
});

describe('actorHealth', () => {
  it('adds temp only when there is some, and names the states that change the number', () => {
    expect(actorHealth(actor({ health: 64 }))).toBe('64 HP');
    expect(actorHealth(actor({ health: 30, temp: 20 }))).toBe('30+20 HP');
    expect(actorHealth(actor({ health: 300, incap: true }))).toBe('300 HP, down');
    expect(actorHealth(actor({ health: 250, ghost: true }))).toBe('250 HP, ghost');
  });
});
