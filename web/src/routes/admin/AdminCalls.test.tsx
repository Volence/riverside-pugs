import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/preact';
import type { ModCallView } from '../../api';

const { mockMod } = vi.hoisted(() => ({ mockMod: { calls: vi.fn() } }));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});

const { AdminCalls } = await import('./AdminCalls');

const call = (over: Partial<ModCallView> = {}): ModCallView => ({
  id: 1, createdAt: '2026-09-24T10:00:00.000Z', serverName: 'Dallas', map: 'l4d_vs_hospital01_apartment', matchId: 12,
  moment: { ordinal: 1, half: 2, tMs: 61500 }, reason: 'cheating', reasonLabel: 'Cheating', via: 'game',
  caller: { steamid: '76561198000000001', name: 'Caller One' },
  target: { kind: 'player', steamid: '76561198000000002', name: 'The Accused' },
  text: 'walls', ticketId: 5, note: '', postState: 'posted', pinged: true,
  handledBy: null, handledAt: null, folded: [], ...over,
});

beforeEach(() => { mockMod.calls.mockReset(); });
afterEach(() => { cleanup(); });

describe('AdminCalls', () => {
  it('warns when calls are not reaching Discord', async () => {
    mockMod.calls.mockResolvedValue({ calls: [], discordReady: false });
    render(<AdminCalls />);
    expect(await screen.findByText(/Calls are not reaching Discord/)).toBeTruthy();
  });

  it('shows no warning when Discord is ready', async () => {
    mockMod.calls.mockResolvedValue({ calls: [call()], discordReady: true });
    render(<AdminCalls />);
    await screen.findByText('Caller One');
    expect(screen.queryByText(/Calls are not reaching Discord/)).toBeNull();
  });

  it('renders a folded call under its parent, with its links', async () => {
    const child = call({
      id: 2, reason: 'griefing', reasonLabel: 'Griefing / throwing', caller: { steamid: '76561198000000003', name: 'Caller Two' },
      text: 'me too', ticketId: null, moment: null,
    });
    mockMod.calls.mockResolvedValue({ calls: [call({ folded: [child] })], discordReady: true });
    render(<AdminCalls />);
    const folded = await screen.findByRole('list', { name: 'Folded into call 1' });
    expect(within(folded).getByText('Caller Two')).toBeTruthy();
    expect(within(folded).getByText('Griefing / throwing')).toBeTruthy();
    expect(within(folded).queryByText('Caller One')).toBeNull();
    expect(screen.getByText('ticket #5').getAttribute('href')).toBe('/admin/people/tickets/5');
    expect(screen.getAllByText('replay moment')[0].getAttribute('href')).toBe('/match/12?ordinal=1&half=2&t=61500');
  });

  it('says a team call is about their team', async () => {
    mockMod.calls.mockResolvedValue({
      calls: [call({ target: { kind: 'team', steamid: null, name: null }, handledAt: '2026-09-24T10:05:00.000Z', handledBy: 'Mod Person' })],
      discordReady: true,
    });
    render(<AdminCalls />);
    expect(await screen.findByText('about their team')).toBeTruthy();
    expect(screen.getByText(/Handled by Mod Person/)).toBeTruthy();
  });
});
