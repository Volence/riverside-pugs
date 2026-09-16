import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { ConnectPanel } from './ConnectPanel';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const CONNECT = { host: '45.32.199.85', port: 27015, password: 'pug_a1b2c3d4' };

describe('ConnectPanel', () => {
  it('links straight into the game with the match password', () => {
    render(<ConnectPanel connect={CONNECT} />);
    const link = screen.getByRole('link', { name: /join server/i });
    expect(link.getAttribute('href')).toBe('steam://connect/45.32.199.85:27015/pug_a1b2c3d4');
  });

  it('shows the console line as a fallback', () => {
    render(<ConnectPanel connect={CONNECT} />);
    expect(screen.getByText('connect 45.32.199.85:27015; password pug_a1b2c3d4')).toBeTruthy();
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
