import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { ConnectPanel } from './ConnectPanel';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const CONNECT = { host: '45.32.199.85', port: 27015, password: 'pug_a1b2c3d4' };

describe('ConnectPanel', () => {
  // Regression guard, from the first real join attempt on 2026-09-16. The line
  // used to read "connect ...; password ...", which connects BEFORE the
  // password is set, so the server answered "Bad password". Source needs the
  // password first. Verified in game: reversed, it works; as it was, it does
  // not. Assert the whole string so the order cannot drift back.
  it('sets the password before connecting, not after', () => {
    render(<ConnectPanel connect={CONNECT} />);
    expect(
      screen.getByText('password pug_a1b2c3d4; connect 45.32.199.85:27015'),
    ).toBeTruthy();
  });

  it('puts the password ahead of the connect in the copied text', () => {
    render(<ConnectPanel connect={CONNECT} />);
    const line = screen.getByText(/connect 45\.32\.199\.85:27015/).textContent ?? '';
    expect(line.indexOf('password')).toBeLessThan(line.indexOf('connect'));
  });

  // Secondary path. It does carry the password, but L4D1 pre-fills the prompt
  // and waits for Enter, and not pressing it looks identical to a rejection,
  // so the panel has to say so or the link reads as broken.
  it('offers the steam link with the Enter caveat, but leads with the console line', () => {
    render(<ConnectPanel connect={CONNECT} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('steam://connect/45.32.199.85:27015/pug_a1b2c3d4');
    expect(screen.getByText(/press Enter/i)).toBeTruthy();
    // The primary control is the copy button, not the link.
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
  });

  it('clears the pending copy timeout on unmount instead of leaking it', async () => {
    // The environment's clipboard may be missing or throw; stub it directly
    // rather than relying on it, per the earlier ruling on this test file.
    // happy-dom exposes `clipboard` as a getter-only property, so it must be
    // redefined rather than assigned.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { unmount } = render(<ConnectPanel connect={CONNECT} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /copy/i })); });
    // The click's copy() is async (it awaits clipboard.writeText), so by the
    // time "Copied" is on screen the 2s reset timeout has definitely been
    // scheduled.
    expect(await screen.findByText('Copied')).toBeTruthy();
    // Not simply the last setTimeout call: @testing-library's act() flushes
    // its own zero-delay timer around the click, so pick out the 2000ms one
    // by its actual delay rather than by call order.
    const copyTimeoutCall = setSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
    const timeoutId = setSpy.mock.results[copyTimeoutCall]?.value;
    expect(timeoutId).toBeTruthy();

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(timeoutId);
  });
});
