import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { CastMatch } from '../api';

const { mockCast } = vi.hoisted(() => ({ mockCast: { list: vi.fn() } }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, castApi: mockCast };
});

const { ApiError } = await import('../api');
const { Cast } = await import('./Cast');

afterEach(() => { cleanup(); mockCast.list.mockReset(); });

const match = (over: Partial<CastMatch> = {}): CastMatch => ({
  id: 240, campaign: 'dead_air', campaignName: 'Dead Air', currentMap: 'l4d_vs_airport02_offices',
  mapNumber: 2, mapCount: 5, teamAScore: 612, teamBScore: 480, phase: 'live', half: 2, serverName: 'Dallas',
  teamA: ['alice', 'bob'], teamB: ['carol', 'dave'],
  connect: { host: '1.2.3.4', port: 27015, password: 'pug_abc' },
  spectate: null,
  booked: false,
  ...over,
});

describe('Cast', () => {
  it('shows each live match with its game server connect line, password first', async () => {
    mockCast.list.mockResolvedValue({ matches: [match()] });
    render(<Cast />);
    expect(await screen.findByText('password pug_abc; connect 1.2.3.4:27015')).toBeTruthy();
    expect(screen.getByText(/Dallas/)).toBeTruthy();
    expect(screen.getByText(/alice, bob/)).toBeTruthy();
    expect(screen.getByText(/Do not pick a team/)).toBeTruthy();
  });

  it('shows the map number, the running score and what the game is doing', async () => {
    mockCast.list.mockResolvedValue({ matches: [match()] });
    render(<Cast />);
    expect(await screen.findByText(/Map 2 of 5 · The Crane/)).toBeTruthy();
    expect(screen.getByLabelText('Score 612 to 480')).toBeTruthy();
    expect(screen.getByText('Live · Round 2')).toBeTruthy();
  });

  it('says why there is no password for a match started in game', async () => {
    mockCast.list.mockResolvedValue({ matches: [match({ connect: null })] });
    render(<Cast />);
    expect(await screen.findByText(/does not know this server's password/)).toBeTruthy();
    expect(screen.queryByText(/^password /)).toBeNull();
  });

  it('a booked scrim shows only its SourceTV line with the relay password, never a game server line', async () => {
    mockCast.list.mockResolvedValue({ matches: [match({
      connect: null, booked: true, spectate: { host: '5.6.7.8', port: 27020, password: 'tvbooked', delay: 0 },
    })] });
    render(<Cast />);
    expect(await screen.findByText('password tvbooked; connect 5.6.7.8:27020')).toBeTruthy();
    expect(screen.getByText(/A booked scrim: watch it through SourceTV/)).toBeTruthy();
    expect(screen.queryByText(/does not know this server's password/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Steam' })).toBeNull();
  });

  it('says so when nothing is live', async () => {
    mockCast.list.mockResolvedValue({ matches: [] });
    render(<Cast />);
    expect(await screen.findByText(/No match is live/)).toBeTruthy();
  });

  it('tells someone without the flag that the page is for casters', async () => {
    mockCast.list.mockRejectedValue(new ApiError(403, 'casters only'));
    render(<Cast />);
    await waitFor(() => expect(screen.getByText(/This page is for casters/)).toBeTruthy());
  });
});
