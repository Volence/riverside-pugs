import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ChatLineView } from '../../api';

const { mockMod } = vi.hoisted(() => ({ mockMod: { chatServers: vi.fn(), chatLines: vi.fn(), chatEarlier: vi.fn(), chatSend: vi.fn(), chatPlayers: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});
const hubHandlers = vi.hoisted(() => [] as (() => void)[]);
vi.mock('../../hooks/useHubEvent', () => ({ useHubEvent: (_e: string[], fn: () => void) => { hubHandlers.push(fn); } }));
/** The latest render's server_chat handler, i.e. what a hub event would run. */
const hubEvent = () => hubHandlers[hubHandlers.length - 1]();

const { ChatDrawer } = await import('./ChatDrawer');

const P = '76561198000000001';
const line = (over: Partial<ChatLineView> = {}): ChatLineView => ({
  id: 1, at: Date.UTC(2026, 8, 28, 20, 0), kind: 'say', steamid: P, name: 'Zoey', team: 2, scope: 'all',
  message: 'hello', matchId: null, siteName: null, matchTeam: null, to: null, delivered: null, ...over,
});
const SERVERS = { servers: [{ id: 3, name: 'Dallas', state: 'match', lastAt: null }, { id: 4, name: 'Riverside #3', state: 'practice', lastAt: null }] };

beforeEach(() => {
  hubHandlers.length = 0;
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
    expect(screen.getByText('(Survivor team chat)')).toBeTruthy();
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

  it('drops a late answer for a server it no longer shows', async () => {
    let resolveThree!: (v: { server: { id: number; name: string }; lines: ChatLineView[] }) => void;
    const threePromise = new Promise<{ server: { id: number; name: string }; lines: ChatLineView[] }>((resolve) => {
      resolveThree = resolve;
    });
    mockMod.chatLines.mockImplementation((id: number) => {
      if (id === 3) return threePromise;
      return Promise.resolve({ server: { id: 4, name: 'Riverside #3' }, lines: [line({ id: 9, message: 'from four' })] });
    });
    const { rerender } = render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    rerender(<ChatDrawer serverId={4} onPick={() => {}} onClose={() => {}} />);
    await screen.findByText('from four');

    // The server-3 request, which lost the race, answers only now. Flush a
    // macrotask so its `await` settles and its (dropped) continuation runs
    // before asserting nothing changed on the strength of it.
    resolveThree({ server: { id: 3, name: 'Dallas' }, lines: [line({ id: 8, message: 'from three' })] });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('from four')).toBeTruthy();
    expect(screen.queryByText('from three')).toBeNull();
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

  it('reloads after a failed send so the row shows "not sent", and keeps the error', async () => {
    const { ApiError } = await import('../../api');
    mockMod.chatLines.mockResolvedValueOnce({ server: { id: 3, name: 'Dallas' }, lines: [] });
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [
      line({ id: 7, kind: 'staff_out', steamid: null, name: 'Volence', to: { kind: 'all', value: null, name: null }, delivered: -1, message: 'x' }),
    ] });
    mockMod.chatSend.mockRejectedValue(new ApiError(502, 'Could not reach the server.'));
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.input(await screen.findByLabelText('Message'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('not sent')).toBeTruthy();
    expect(mockMod.chatLines).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Could not reach the server.')).toBeTruthy();
  });

  describe('following new chat', () => {
    const window200 = (last: number) => ({ server: { id: 3, name: 'Dallas' },
      lines: Array.from({ length: 200 }, (_, i) => line({ id: last - 199 + i, message: `m${last - 199 + i}` })) });
    /** jsdom has no layout: give the log a 1000px body in a 200px box and
     *  record every scrollTop write. */
    const fakeLayout = (log: HTMLElement) => {
      const writes: number[] = [];
      let top = 0;
      Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 200 });
      Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; writes.push(v); } });
      return { writes, scrollTo: (v: number) => { top = v; fireEvent.scroll(log); } };
    };

    it('scrolls to a new last line even when the window stays at 200', async () => {
      mockMod.chatLines.mockResolvedValue(window200(200));
      render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
      await screen.findByText('m200');
      const log = screen.getByRole('log');
      const { writes, scrollTo } = fakeLayout(log);
      scrollTo(790); // within 40px of the bottom (800)
      writes.length = 0;
      mockMod.chatLines.mockResolvedValue(window200(201));
      hubEvent();
      await screen.findByText('m201');
      await waitFor(() => expect(writes).toContain(1000));
    });

    it('leaves staff reading history where they are', async () => {
      mockMod.chatLines.mockResolvedValue(window200(200));
      render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
      await screen.findByText('m200');
      const log = screen.getByRole('log');
      const { writes, scrollTo } = fakeLayout(log);
      scrollTo(300);
      writes.length = 0;
      mockMod.chatLines.mockResolvedValue(window200(201));
      hubEvent();
      await screen.findByText('m201');
      await new Promise((r) => setTimeout(r, 0));
      expect(writes).toEqual([]);
    });
  });

  it('Whisper... picks someone on the server now, with no chat line needed', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    mockMod.chatPlayers.mockResolvedValue({ players: [{ steamid: P, name: 'Zoey' }, { steamid: '76561198000000002', name: 'Francis' }] });
    mockMod.chatSend.mockResolvedValue({ ok: true, id: 9 });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Send to'), { target: { value: 'whisper' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Francis' }));
    expect(mockMod.chatPlayers).toHaveBeenCalledWith(3);
    expect(screen.getByText('Whisper to Francis')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'check your rates' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockMod.chatSend).toHaveBeenCalledWith(3, { to: 'player', steamid: '76561198000000002', message: 'check your rates' }));
  });

  it('Whisper... says so when nobody is on or the server cannot be reached', async () => {
    const { ApiError } = await import('../../api');
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    mockMod.chatPlayers.mockResolvedValueOnce({ players: [] });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Send to'), { target: { value: 'whisper' } });
    expect(await screen.findByText('Nobody is on the server.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    mockMod.chatPlayers.mockRejectedValueOnce(new ApiError(502, 'Could not reach the server.'));
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: 'whisper' } });
    expect(await screen.findByText('Could not reach the server.')).toBeTruthy();
  });

  it('heads the current match, and Show earlier chat adds older lines with their own dividers', async () => {
    mockMod.chatLines.mockResolvedValue({
      server: { id: 3, name: 'Dallas' }, currentMatchId: 12, hasEarlier: true,
      lines: [line({ id: 20, matchId: 12, message: 'now' })],
    });
    mockMod.chatEarlier.mockResolvedValue({
      server: { id: 3, name: 'Dallas' }, hasEarlier: false,
      lines: [line({ id: 5, matchId: 11, message: 'last game' }), line({ id: 9, matchId: null, message: 'lobby' })],
    });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    await screen.findByText('now');
    expect(screen.getByText('Match #12')).toBeTruthy();
    expect(screen.queryByText('last game')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier chat' }));
    await screen.findByText('last game');
    expect(mockMod.chatEarlier).toHaveBeenCalledWith(3, 20, expect.anything());
    expect(screen.getByText('Match #11')).toBeTruthy();
    expect(screen.getByText('Between matches')).toBeTruthy();
    // Nothing older is left, so the button goes.
    expect(screen.queryByRole('button', { name: 'Show earlier chat' })).toBeNull();
  });

  it('offers no earlier chat when there is none', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, currentMatchId: null, hasEarlier: false, lines: [line()] });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    await screen.findByText('hello');
    expect(screen.queryByRole('button', { name: 'Show earlier chat' })).toBeNull();
  });
});


describe('ChatDrawer speaker names', () => {
  it('leads with the site name and team, and shows the in-game name and team chat side', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, currentMatchId: 367, hasEarlier: false,
      lines: [line({ name: 'Spoken For', siteName: 'Anna', matchTeam: 'a', scope: 'team', matchId: 367 })] });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    const log = await screen.findByRole('log');
    await waitFor(() => expect(log.textContent).toContain('Team A'));
    expect(screen.getByRole('button', { name: 'Anna' })).toBeTruthy();
    expect(log.textContent).toContain('as "Spoken For"');
    expect(log.textContent).toContain('(Survivor team chat)');
  });

  it('shows no in-game name when it matches the site name', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, currentMatchId: null, hasEarlier: false,
      lines: [line({ siteName: 'Zoey' })] });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Zoey' });
    expect(screen.getByRole('log').textContent).not.toContain('as "');
  });
});
