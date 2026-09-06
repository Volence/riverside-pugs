import { useEffect, useState } from 'preact/hooks';
import { ApiError } from '../api';

export interface FetchState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

/** Run an async loader, keyed by `deps`, and expose its result.
 *
 *  The `cancelled` flag is the load-bearing part, and it is the Preact
 *  equivalent of the `nav` token the old app.js carried (see commit 8975b0f):
 *  when the route changes while a request is in flight, the older request's
 *  response must not be written to state, or a slow /api/players/:id paints
 *  over whatever page the user navigated to since.
 *
 *  The abort signal alone is not enough to guarantee that. An already-resolved
 *  promise still runs its `.then`, and a fetch stub may ignore the signal
 *  entirely, so the flag is checked on every settle path, not just relied upon
 *  as a nicety. The signal is passed as well so a genuinely in-flight request
 *  stops occupying a connection. */
export function useFetch<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): FetchState<T> & { reload: () => void } {
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));

    loader(ctrl.signal).then(
      (data) => {
        if (cancelled) return;
        setState({ data, error: null, loading: false });
      },
      (err) => {
        if (cancelled) return;
        // An abort is the expected outcome of navigating away, not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ data: null, error: err as Error, loading: false });
      },
    );

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
