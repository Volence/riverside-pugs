import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AbortNotice } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { dismissAbortNotice: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { AbortNoticePanel, LobbyNotice } = await import('./Play');

const notice = (over: Partial<AbortNotice> = {}): AbortNotice => ({
  matchId: 212, cause: 'abandon', reason: 'a player ran out of reconnect time', role: 'innocent', requeued: true, ...over,
});

beforeEach(() => mockApi.dismissAbortNotice.mockResolvedValue({ ok: true }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AbortNoticePanel', () => {
  it('tells a blameless player why, and that they are back at the front of the queue', () => {
    render(<AbortNoticePanel notice={notice()} refresh={() => {}} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/Match #212 was aborted/);
    expect(body).toMatch(/a player ran out of reconnect time/);
    expect(body).toMatch(/back at the front of the queue/);
  });

  it('tells a no-show it was them, and what it costs', () => {
    render(<AbortNoticePanel notice={notice({ cause: 'no_show', reason: 'not enough players connected in time', role: 'culprit', requeued: false })} refresh={() => {}} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/never connected/i);
    expect(body).toMatch(/queue timeout/i);
    expect(body).not.toMatch(/front of the queue/);
  });

  it('tells a file check reject it is not a no-show and where to fix it', () => {
    render(<AbortNoticePanel notice={notice({ cause: 'no_show', role: 'file_check', requeued: false })} refresh={() => {}} />);
    expect(document.body.textContent).toMatch(/not a no-show/);
    expect((screen.getByRole('link', { name: 'How to fix it' }) as HTMLAnchorElement).getAttribute('href')).toBe('/help/consistency');
  });

  it('dismisses on the server, then refreshes', async () => {
    const refresh = vi.fn();
    render(<AbortNoticePanel notice={notice()} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mockApi.dismissAbortNotice).toHaveBeenCalled();
  });
});

describe('LobbyNotice for a pop staff cancelled', () => {
  it('says staff cancelled it and nobody was penalised', () => {
    render(<LobbyNotice notice={{ notReady: [], youWereReady: true, cancelled: true }} refresh={() => {}} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/Pop cancelled/);
    expect(body).toMatch(/Staff cancelled the pop/);
    expect(body).toMatch(/front of the queue/);
  });
});
