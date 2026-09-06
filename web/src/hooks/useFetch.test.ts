import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/preact';
import { useFetch } from './useFetch';

/** A promise whose resolution this test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let a settled promise's continuation run AND let Preact flush the rerender
 *  it would cause. Awaiting a couple of microtasks is not enough — the render
 *  is scheduled on a later task, so a test that only drains microtasks passes
 *  whether or not the stale-response guard is present. Verified: removing the
 *  guard makes the two "stale" cases below fail with this helper, and not
 *  without it. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('useFetch', () => {
  it('exposes the loaded value', async () => {
    const { result } = renderHook(() => useFetch(async () => 'hello', ['k']));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('hello');
    expect(result.current.error).toBeNull();
  });

  /* The regression this hook exists for. In the vanilla frontend a slow
   * /api/players/:id could resolve after the user had already navigated
   * elsewhere and paint over the page they were looking at (fixed in 8975b0f
   * with a nav token). Here the guard is the `cancelled` flag in the effect
   * cleanup, and this is the test that holds it in place. */
  it('ignores a stale response that resolves after the deps changed', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const loaders = [() => slow.promise, () => fast.promise];

    let key = 0;
    const { result, rerender } = renderHook(() => useFetch(() => loaders[key](), [key]));

    // Navigate away before the first request settles.
    key = 1;
    rerender();

    fast.resolve('page two');
    await waitFor(() => expect(result.current.data).toBe('page two'));

    // The abandoned first request now lands. It must not overwrite page two.
    slow.resolve('page one');
    await settle();

    expect(result.current.data).toBe('page two');
  });

  it('ignores a stale rejection too, rather than showing an error on the new page', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const loaders = [() => slow.promise, () => fast.promise];

    let key = 0;
    const { result, rerender } = renderHook(() => useFetch(() => loaders[key](), [key]));

    key = 1;
    rerender();
    fast.resolve('page two');
    await waitFor(() => expect(result.current.data).toBe('page two'));

    slow.reject(new Error('too late'));
    await settle();

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('page two');
  });

  it('surfaces a real failure', async () => {
    const { result } = renderHook(() =>
      useFetch(async () => { throw new Error('boom'); }, ['k']),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect((result.current.error as Error).message).toBe('boom');
  });

  it('treats an abort as navigation, not as an error to display', async () => {
    const { result } = renderHook(() =>
      useFetch(async () => { throw new DOMException('aborted', 'AbortError'); }, ['k']),
    );
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it('aborts the in-flight request when the deps change', async () => {
    const seen: AbortSignal[] = [];
    let key = 0;
    const { rerender } = renderHook(() =>
      useFetch((signal) => { seen.push(signal); return new Promise<string>(() => {}); }, [key]),
    );
    expect(seen[0].aborted).toBe(false);
    key = 1;
    rerender();
    await waitFor(() => expect(seen[0].aborted).toBe(true));
  });

  it('re-runs the loader on reload()', async () => {
    const loader = vi.fn(async () => 'v');
    const { result } = renderHook(() => useFetch(loader, ['k']));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loader).toHaveBeenCalledTimes(1);
    result.current.reload();
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });
});
