import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ChatLineView } from '../../api';

const { mockMod } = vi.hoisted(() => ({ mockMod: { chatServers: vi.fn(), chatLines: vi.fn(), chatSend: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});
vi.mock('../../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));

const { ChatDrawer } = await import('./ChatDrawer');

const P = '76561198000000001';
const line = (over: Partial<ChatLineView> = {}): ChatLineView => ({
  id: 1, at: Date.UTC(2026, 8, 28, 20, 0), kind: 'say', steamid: P, name: 'Zoey', team: 2, scope: 'all',
  message: 'hello', matchId: null, to: null, delivered: null, ...over,
});
const SERVERS = { servers: [{ id: 3, name: 'Dallas', state: 'match', lastAt: null }, { id: 4, name: 'Riverside #3', state: 'practice', lastAt: null }] };

beforeEach(() => {
  for (const f of Object.values(mockMod)) f.mockReset();
  mockMod.chatServers.mockResolvedValue(SERVERS);
});
afterEach(() => cleanup());

describe('ChatDrawer', () => {
  it('picks another server', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    const onPick = vi.fn();
    render(<ChatDrawer serverId={3} onPick={onPick} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Server'), { target: { value: '4' } });
    expect(onPick).toHaveBeenCalledWith(4);
  });

  it('closes', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    const onClose = vi.fn();
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close chat' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows lines with team chat and staff messages marked', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [
      line(),
      line({ id: 2, scope: 'team', message: 'rush' }),
      line({ id: 3, kind: 'staff_in', message: 'he is throwing' }),
      line({ id: 4, kind: 'staff_out', steamid: null, name: 'Volence', to: { kind: 'player', value: P, name: 'Zoey' }, delivered: 1, message: 'watching' }),
      line({ id: 5, kind: 'staff_out', steamid: null, name: 'Volence', to: { kind: 'player', value: P, name: 'Zoey' }, delivered: 0, message: 'gone?' }),
    ] });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    await screen.findByText('hello');
    expect(screen.getByText('(team)')).toBeTruthy();
    expect(screen.getByText('to staff')).toBeTruthy();
    expect(screen.getAllByText(/whisper to Zoey/)).toHaveLength(2);
    expect(screen.getByText('delivered to 1')).toBeTruthy();
    expect(screen.getByText('not on the server')).toBeTruthy();
  });

  it('clicking a name switches to a whisper and sends it', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [line()] });
    mockMod.chatSend.mockResolvedValue({ ok: true, id: 9 });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Zoey' }));
    expect(screen.getByText('Whisper to Zoey')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'on it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockMod.chatSend).toHaveBeenCalledWith(3, { to: 'player', steamid: P, message: 'on it' }));
  });

  it('sends to a team', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    mockMod.chatSend.mockResolvedValue({ ok: true, id: 9 });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Send to'), { target: { value: 'team:3' } });
    fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'hold' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockMod.chatSend).toHaveBeenCalledWith(3, { to: 'team', team: 3, message: 'hold' }));
  });

  it('shows the server error on a failed send', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    const { ApiError } = await import('../../api');
    mockMod.chatSend.mockRejectedValue(new ApiError(502, 'This server needs pug-match 0.3.16 to send.'));
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.input(await screen.findByLabelText('Message'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This server needs pug-match 0.3.16 to send.')).toBeTruthy();
  });
});
