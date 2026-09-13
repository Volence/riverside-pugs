import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { useTheater } from './useTheater';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.classList.remove('is-theater'); });

function mount() {
  let api!: ReturnType<typeof useTheater>;
  function Host() {
    const ref = useRef<HTMLDivElement>(null);
    api = useTheater(ref);
    return <div ref={ref} data-testid="root" />;
  }
  const r = render(<Host />);
  return { get api() { return api; }, root: r.getByTestId('root') as HTMLElement };
}

describe('useTheater', () => {
  it('starts off, toggles on and marks the body', () => {
    const h = mount();
    expect(h.api.theater).toBe(false);
    act(() => h.api.toggle());
    expect(h.api.theater).toBe(true);
    expect(document.body.classList.contains('is-theater')).toBe(true);
    act(() => h.api.toggle());
    expect(h.api.theater).toBe(false);
    expect(document.body.classList.contains('is-theater')).toBe(false);
  });

  it('Escape leaves theater', () => {
    const h = mount();
    act(() => h.api.enter());
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(h.api.theater).toBe(false);
  });

  it('requests fullscreen on the root when the browser offers it, and survives its refusal', () => {
    const h = mount();
    const req = vi.fn(() => Promise.reject(new Error('denied')));
    (h.root as HTMLElement & { requestFullscreen: () => Promise<void> }).requestFullscreen = req;
    act(() => h.api.enter());
    expect(req).toHaveBeenCalledTimes(1);
    expect(h.api.theater).toBe(true);
  });

  it('leaving browser fullscreen leaves theater', () => {
    const h = mount();
    act(() => h.api.enter());
    // fullscreenElement is null in happy-dom, which is what "left" looks like.
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(h.api.theater).toBe(false);
  });
});
