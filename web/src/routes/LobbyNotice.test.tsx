import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({ mockApi: { dismissNotice: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { LobbyNotice } = await import('./Play');

const p = (name: string) => ({ steamid: `7656119800000000${name.length}`, name, avatar: null, sr: 1000 });

beforeEach(() => mockApi.dismissNotice.mockResolvedValue({ ok: true }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('LobbyNotice', () => {
  // The whole point of the banner: a player who did everything right is told
  // it was not them, and told they kept their place.
  it('tells a ready player who cost them the pop and that they kept their place', () => {
    render(<LobbyNotice notice={{ notReady: [p('abe'), p('bo')], youWereReady: true }} refresh={() => {}} />);
    expect(screen.getByText(/ready check failed/i)).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/abe, bo/);
    expect(body).toMatch(/front of the queue/i);
  });

  it('tells a player who missed it that it was them, and that it costs a timeout', () => {
    render(<LobbyNotice notice={{ notReady: [p('abe')], youWereReady: false }} refresh={() => {}} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/did not ready up/i);
    expect(body).toMatch(/timeout/i);
    // Never name-and-shame the reader to themselves.
    expect(body).not.toMatch(/abe/);
  });

  it('says the pop was cancelled because a player was removed, and blames nobody for not readying', () => {
    render(<LobbyNotice notice={{ notReady: [], youWereReady: true, removed: p('mallory') }} refresh={() => {}} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/pop cancelled/i);
    expect(body).toMatch(/mallory was removed/i);
    expect(body).toMatch(/front of the queue/i);
    expect(body).not.toMatch(/ready check failed/i);
    expect(body).not.toMatch(/did not/i);
  });

  // Called rather than counted: @testing-library/preact replays a click onto
  // earlier renders in the same file, so an exact count measures the harness
  // and not this component. What stops a real double submit is the button
  // disabling itself, which is asserted directly below.
  it('dismissing clears it on the server, not just in the browser', async () => {
    const refresh = vi.fn();
    render(<LobbyNotice notice={{ notReady: [p('abe')], youWereReady: true }} refresh={refresh} />);
    const btn = screen.getByRole('button', { name: /dismiss/i }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    await waitFor(() => expect(mockApi.dismissNotice).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

});
