// web/src/routes/EventDraft.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DraftRoomView, PlayerCardView } from '../api';

const { mockEvents, pop, hub } = vi.hoisted(() => ({
  mockEvents: { draftRoom: vi.fn(), draftPick: vi.fn(), draftHeartbeat: vi.fn(), draftCards: vi.fn(), draftList: vi.fn(), saveDraftList: vi.fn() },
  pop: vi.fn(),
  hub: { fn: null as null | (() => void), names: [] as string[] },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../popSound', () => ({ playPopSound: pop }));
vi.mock('../hooks/useHubEvent', () => ({ useHubEvent: (names: string[], fn: () => void) => { hub.names = names; hub.fn = fn; } }));
const { EventDraftPage } = await import('./EventDraft');
const { ApiError } = await import('../api');

const card = (steamid: string, name: string, sr: number): PlayerCardView => ({
  steamid, name, avatar: null, sr, trend: [sr - 30, sr], pugs: 12, form: ['W', 'L'],
  survivor: { siDamage: 210.5, commonKills: 31 }, infected: { damageAsSi: 180, dpsLanded: 1.5 },
  bestClass: { cls: 'hunter', damage: 4000 }, skills: [{ key: 'skeets', label: 'Skeets', total: 9 }],
});
const view = (over: Partial<DraftRoomView> = {}): DraftRoomView => { const t = Date.now(); return {
  eventId: 4, slug: 'night', eventName: 'Draft Night', status: 'running', teamsMadeAt: null,
  settings: { firstPick: 'lowest_sr', pickSeconds: 75 },
  serverNow: new Date(t).toISOString(), deadlineAt: new Date(t + 75_000).toISOString(), pausedLeftMs: null, totalPicks: 6,
  order: [{ steamid: 'c1', name: 'Ann' }, { steamid: 'c2', name: 'Eve' }],
  onClock: { pickNo: 1, round: 1, captain: 'c1', picker: 'c1' },
  picks: [], delegates: {},
  teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
  pool: [card('p1', 'Bob', 1200), card('p2', 'Cy', 1350), card('p3', 'Di', 1100)],
  notes: null,
  me: { role: null, team: null, onClock: false, list: null, chemistry: null },
  lists: null, staff: false,
  ...over,
}; };
const session = { kind: 'anonymous' } as const;
const cardNames = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mockEvents.draftHeartbeat.mockResolvedValue({ ok: true });
  mockEvents.draftPick.mockResolvedValue({ pickNo: 1, done: false });
});

describe('EventDraftPage', () => {
  it('shows who is on the clock with a countdown, and the pool by SR with no Pick button for a viewer', async () => {
    mockEvents.draftRoom.mockResolvedValue(view());
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('Ann is on the clock')).toBeTruthy();
    expect(screen.getByLabelText('Time left').textContent).toMatch(/^1:1[45]$/);
    expect(screen.getByText('Pick 1 of 6 · Round 1')).toBeTruthy();
    expect(cardNames()).toEqual(['Cy', 'Bob', 'Di']);
    expect(screen.getAllByText('+30 SR across the last 2 rated games')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Pick / })).toBeNull();
    expect(hub.names).toEqual(['draft:4']);
    expect(mockEvents.draftHeartbeat).not.toHaveBeenCalled();
  });

  it('lets the captain on the clock pick, beats, and chimes once when the turn starts', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({
      me: { role: 'captain', team: 'c1', onClock: true, list: [], chemistry: { p1: { together: 4, wonTogether: 3, against: 2, wonAgainst: 1 } } },
      notes: { p1: 'prefer infected' },
    }));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('You are on the clock')).toBeTruthy();
    expect(pop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockEvents.draftHeartbeat).toHaveBeenCalledWith('night'));
    expect(screen.getByText('With you: 4 games, 3 won · Against you: 2, you won 1')).toBeTruthy();
    expect(screen.getByText('Note: prefer infected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick Bob' }));
    await waitFor(() => expect(mockEvents.draftPick).toHaveBeenCalledWith('night', 'p1', 1));
    hub.fn!();
    await waitFor(() => expect(mockEvents.draftRoom).toHaveBeenCalledTimes(3));
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it('shows the server sentence when a pick is refused', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({ me: { role: 'captain', team: 'c1', onClock: true, list: [], chemistry: {} } }));
    mockEvents.draftPick.mockRejectedValue(new ApiError(409, 'That pick was already made. The room has moved on.'));
    render(<EventDraftPage slug="night" session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Cy' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That pick was already made. The room has moved on.');
  });

  it('reveals a pick it had not seen, but none on first load', async () => {
    const first = { pickNo: 1, round: 1, captain: 'c1', steamid: 'p9', name: 'Old', auto: false, at: '2026-10-08T10:00:00.000Z' };
    mockEvents.draftRoom.mockResolvedValue(view({ picks: [first] }));
    render(<EventDraftPage slug="night" session={session} />);
    await screen.findByText('Ann is on the clock');
    expect(screen.queryByRole('status')).toBeNull();
    mockEvents.draftRoom.mockResolvedValue(view({ picks: [first, { pickNo: 2, round: 1, captain: 'c2', steamid: 'p2', name: 'Cy', auto: true, at: '2026-10-08T10:01:00.000Z' }] }));
    hub.fn!();
    const reveal = await screen.findByRole('status');
    expect(reveal.textContent).toContain('Pick 2');
    expect(reveal.textContent).toContain('Cy');
    expect(reveal.textContent).toContain("to Eve's team (auto pick)");
  });

  it('fills the board and the pick log, marking auto picks', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({
      picks: [{ pickNo: 1, round: 1, captain: 'c1', steamid: 'p9', name: 'Gus', auto: true, at: '2026-10-08T10:00:00.000Z' }],
      teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [{ steamid: 'p9', name: 'Gus' }] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
      onClock: { pickNo: 2, round: 1, captain: 'c2', picker: 'c2' },
    }));
    render(<EventDraftPage slug="night" session={session} />);
    // One number only: the ordered list numbers the row, the text does not repeat it.
    expect(await screen.findByText('Ann took Gus')).toBeTruthy();
    expect(screen.queryByText(/#1/)).toBeNull();
    expect(screen.getByText('Auto')).toBeTruthy();
    expect(screen.getAllByText('Open')).toHaveLength(5);
  });

  it('labels the recent form row and spells out each result for screen readers and on hover', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({ pool: [{ ...card('p1', 'Bob', 1200), form: ['W', 'L', 'D'] }] }));
    render(<EventDraftPage slug="night" session={session} />);
    const row = await screen.findByLabelText('Recent form: Win, Loss, Draw');
    expect(row.textContent).toContain('Last 3');
    expect(screen.getByTitle('Win').textContent).toBe('W');
    expect(screen.getByTitle('Loss').textContent).toBe('L');
    expect(screen.getByTitle('Draw').textContent).toBe('D');
  });

  it('gives the pick list drawer only the players still free, so picked ones drop out', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({
      pool: [card('p2', 'Cy', 1350), card('p3', 'Di', 1100)],
      me: { role: 'captain', team: 'c1', onClock: false, list: ['p1', 'p2'], chemistry: null },
    }));
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200), card('p2', 'Cy', 1350), card('p3', 'Di', 1100)], notes: {}, chemistry: null });
    mockEvents.draftList.mockResolvedValue({ list: ['p1', 'p2'] });
    render(<EventDraftPage slug="night" session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'My pick list' }));
    expect(await screen.findByText('1. Cy')).toBeTruthy();
    expect(screen.queryByText(/Bob/, { selector: '.picklist *' })).toBeNull();
  });

  it('filters the pool by name and sorts by name', async () => {
    mockEvents.draftRoom.mockResolvedValue(view());
    render(<EventDraftPage slug="night" session={session} />);
    await screen.findByText('Ann is on the clock');
    fireEvent.input(screen.getByLabelText('Find a player'), { target: { value: 'b' } });
    expect(cardNames()).toEqual(['Bob']);
    fireEvent.input(screen.getByLabelText('Find a player'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name' } });
    expect(cardNames()).toEqual(['Bob', 'Cy', 'Di']);
  });

  it('says lists are used if captains pick live while staff have not chosen it, and opens a captain\'s list', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({ status: 'none', onClock: null, deadlineAt: null, me: { role: 'captain', team: 'c1', onClock: false, list: [], chemistry: {} } }));
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200)], notes: {}, chemistry: {} });
    mockEvents.draftList.mockResolvedValue({ list: [] });
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText(/used if captains pick live/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'My pick list' }));
    expect(await screen.findByRole('heading', { name: 'My pick list' })).toBeTruthy();
  });

  it('gives a delegate the board, notes and Pick buttons but no pick list button', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({
      me: { role: 'delegate', team: 'c1', onClock: true, list: null, chemistry: {} },
      notes: { p1: 'prefer infected' },
    }));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('You are on the clock')).toBeTruthy();
    expect(screen.getByText('Note: prefer infected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick Bob' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'My pick list' })).toBeNull();
    await waitFor(() => expect(mockEvents.draftHeartbeat).toHaveBeenCalledWith('night'));
  });

  it('keeps the board and Pick buttons up when a later refetch fails', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({ me: { role: 'captain', team: 'c1', onClock: true, list: [], chemistry: {} } }));
    render(<EventDraftPage slug="night" session={session} />);
    await screen.findByRole('button', { name: 'Pick Bob' });
    mockEvents.draftRoom.mockRejectedValue(new ApiError(500, 'GET x'));
    hub.fn!();
    expect(await screen.findByText('Lost contact with the site, retrying.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick Bob' })).toBeTruthy();
    expect(screen.queryByText('Could not load the draft room.')).toBeNull();
    mockEvents.draftRoom.mockResolvedValue(view({ me: { role: 'captain', team: 'c1', onClock: true, list: [], chemistry: {} } }));
    hub.fn!();
    await waitFor(() => expect(screen.queryByText('Lost contact with the site, retrying.')).toBeNull());
  });

  it('says so when there is no such draft, or the cut is not published', async () => {
    mockEvents.draftRoom.mockRejectedValue(new ApiError(404, 'GET x'));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('No such draft.')).toBeTruthy();
    cleanup();
    mockEvents.draftRoom.mockRejectedValue(new ApiError(409, 'GET x'));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('The draft room opens once the cut is published.')).toBeTruthy();
  });
});
