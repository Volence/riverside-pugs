import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DrillActor, DrillSpec } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { createDrill: vi.fn() } }));
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
beforeEach(() => { mockApi.createDrill.mockReset(); });

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
    expect(screen.getByText(/in a practice server/).textContent).toBe('Type !drill K7QX in a practice server');
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
    const link = screen.getByRole('link', { name: 'Log in to create drills' });
    expect(link.getAttribute('href')!.startsWith('/auth/steam?next=')).toBe(true);
    // A backend route: without _top the SPA router swallows the click.
    expect(link.getAttribute('target')).toBe('_top');
    expect(mockApi.createDrill).not.toHaveBeenCalled();
  });

  it('treats an expired session like being signed out', async () => {
    mockApi.createDrill.mockRejectedValue(new ApiError(401, 'not logged in'));
    render(<DrillThis {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill this' }));
    expect(await screen.findByRole('link', { name: 'Log in to create drills' })).toBeTruthy();
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
