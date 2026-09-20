/* Its own file on purpose. @testing-library/preact replays a click onto
 * components rendered earlier in the SAME file, so a rejecting handler here
 * would also reject inside a component the test has finished with, and that
 * second rejection is reported as unhandled. One render, one click, no
 * neighbours. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({ mockApi: { dismissNotice: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { LobbyNotice } = await import('./Play');

afterEach(cleanup);

describe('LobbyNotice when Discord or the network is down', () => {
  it('re-enables the button so the notice is not a dead end', async () => {
    mockApi.dismissNotice.mockImplementation(() => Promise.reject(new Error('offline')));
    const refresh = vi.fn();
    render(<LobbyNotice notice={{ notReady: [], youWereReady: true }} refresh={refresh} />);
    const btn = screen.getByRole('button', { name: /dismiss/i }) as HTMLButtonElement;

    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    // Back to clickable, and no refresh: nothing was actually cleared.
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(refresh).not.toHaveBeenCalled();
  });
});
