import { useEffect, useRef, useState } from 'preact/hooks';
import {
  decodeFrames, decodeHeader, frameBytes, HEADER_BYTES, VERSION,
  type Frame, type ReplayHeader,
} from '../../../src/replayFormat';

export type ReplaySpec =
  | { kind: 'file'; name: string }
  | { kind: 'match'; matchId: number; ordinal: number; half: number }
  | { kind: 'live'; token: string }
  | { kind: 'live-match'; matchId: number };

/** Both live variants name a session rather than a file: one by a standalone
 *  token, one by a match id whose token the server keeps to itself. They are
 *  handled identically from here on, so the distinction lives only in the URL
 *  that resolves the current filename. */
function isLive(spec: ReplaySpec): boolean {
  return spec.kind === 'live' || spec.kind === 'live-match';
}

export interface ReplayState {
  header: ReplayHeader | null;
  frames: Frame[];
  /** Absolute byte offset to ask for next. Always a frame boundary, which is
   *  what lets a later chunk be decoded on its own. The hook tracks its live
   *  cursor in a ref (cursorRef) instead; this is the pure function's own
   *  return value, which the tests assert on. */
  cursor: number;
  /** The file was written by a format version newer than this page can read.
   *  Nothing was decoded and nothing will be: the viewer says so rather than
   *  showing an empty map that looks like a broken recording. */
  tooNew?: boolean;
}

/** How often a round still being recorded is polled. The server holds frames
 *  back ten seconds regardless, so this interval controls smoothness of
 *  arrival, not how far behind the viewer is. */
const POLL_MS = 1000;

export function replayUrl(spec: ReplaySpec, since: number): string {
  switch (spec.kind) {
    case 'file':
      return `/api/replays/file/${encodeURIComponent(spec.name)}?since=${since}`;
    case 'match':
      return `/api/replays/match/${spec.matchId}/${spec.ordinal}/${spec.half}?since=${since}`;
    case 'live':
      // Live resolves to a filename first, so this is never fetched directly.
      return `/api/replays/live/${encodeURIComponent(spec.token)}`;
    case 'live-match':
      return `/api/replays/live/match/${spec.matchId}`;
  }
}

/**
 * Fold one response body into the running state.
 *
 * Pure, and separated from the fetching for exactly that reason: the offset
 * arithmetic here is the part that can be wrong in a way that looks fine.
 * `decodeFrames` numbers offsets from the start of the buffer it is given, so
 * a chunk that starts `base` bytes into the file produces offsets that are
 * all short by `base`. Seeking, the keyframe index and the next poll's
 * `since` all read those offsets.
 */
export function appendChunk(state: ReplayState, chunk: Uint8Array, base: number): ReplayState {
  if (chunk.length === 0) return state;

  let header = state.header;
  let from = 0;
  if (!header) {
    header = decodeHeader(chunk);
    if (!header) return state;
    // A newer writer may have changed a record's size or the meaning of a
    // field, and the bytes after the header would then decode into something
    // that looks fine and is wrong. Refusing is the only safe answer, and it
    // is the same ceiling `parseReplay` applies on the server. Older versions
    // stay readable: this is a ceiling, not an equality check.
    if (header.version > VERSION) return { ...state, tooNew: true };
    from = HEADER_BYTES;
  }

  const { frames } = decodeFrames(chunk, from, chunk.length);
  const shifted = base === 0 ? frames : frames.map((f) => ({ ...f, offset: f.offset + base }));

  // The cursor is where the last WHOLE frame ended, not where the chunk
  // ended. Those are the same today and would diverge the moment a response
  // stopped mid-frame, which `decodeFrames` is built to tolerate and which
  // would otherwise leave the cursor pointing into the middle of a record and
  // desynchronise every later poll.
  const end = shifted.length
    ? shifted[shifted.length - 1].offset + frameBytes(shifted[shifted.length - 1].entities.length)
    : base + chunk.length;

  return { header, frames: state.frames.concat(shifted), cursor: end };
}

/**
 * Hold a replay, saved or live, and keep it current.
 *
 * The two cases differ only in whether polling continues. A saved round
 * arrives in one response and stops; a live one keeps asking from where it
 * left off. Neither the decoding nor anything downstream knows the
 * difference, which is the whole point of serving live frames as a prefix of
 * the same file format.
 */
export function useReplaySource(spec: ReplaySpec | null): {
  header: ReplayHeader | null;
  frames: Frame[];
  closed: boolean;
  /** The file's format version is newer than this page understands. */
  tooNew: boolean;
  error: Error | null;
} {
  const [state, setState] = useState<ReplayState>({ header: null, frames: [], cursor: 0 });
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // The cursor used to build the next request. Updated synchronously the
  // moment it changes (a fresh chunk, or a live round change resetting it to
  // 0), unlike `state`, which only reflects a `setState` call once Preact
  // gets around to applying it. Reading `state.cursor` back out here would
  // reuse whatever value was current at the START of this render pass, not
  // the one this same tick just decided on.
  const cursorRef = useRef(0);

  const key = spec ? JSON.stringify(spec) : '';

  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let name: string | null = spec.kind === 'file' ? spec.name : null;

    cursorRef.current = 0;
    setState({ header: null, frames: [], cursor: 0 });
    setClosed(false);
    setError(null);

    async function tick(): Promise<void> {
      try {
        // A live spec names a session, not a file. Resolving it every poll is
        // what makes a round change appear on its own: the filename moves on,
        // and the cursor resets with it.
        if (isLive(spec!)) {
          const res = await fetch(replayUrl(spec!, 0));
          if (!res.ok) throw new Error('no live replay');
          const body = (await res.json()) as { filename: string; closed: boolean };
          if (cancelled) return;
          if (body.filename !== name) {
            name = body.filename;
            cursorRef.current = 0;
            setState({ header: null, frames: [], cursor: 0 });
          }
        }

        const cursor = cursorRef.current;
        const url = isLive(spec!)
          ? `/api/replays/file/${encodeURIComponent(name!)}?since=${cursor}`
          : replayUrl(spec!, cursor);

        const res = await fetch(url);
        if (!res.ok) throw new Error(`replay fetch failed: ${res.status}`);
        const chunk = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;

        const isClosed = res.headers.get('X-Replay-Closed') === '1';
        setState((s) => {
          const next = appendChunk(s, chunk, cursor);
          cursorRef.current = next.cursor;
          return next;
        });
        setClosed(isClosed);
        setError(null);

        // A closed FILE has nothing more to say, which is the end of the
        // story for a 'file' or 'match' spec: stopping here is what keeps a
        // finished replay from polling forever on somebody's open tab.
        // A live spec names a session, not a file, though: this round's file
        // closing just means the next round is about to write a new one under
        // the same session, and only re-resolving the session (at the top of
        // the next tick) can discover it. So a live spec keeps polling
        // regardless of this file's closed state.
        if ((isLive(spec!) || !isClosed) && !cancelled) timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e as Error);
        // Keep trying. A live page left open across a server restart should
        // recover on its own rather than needing a refresh.
        timer = setTimeout(tick, POLL_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return { header: state.header, frames: state.frames, closed, tooNew: state.tooNew === true, error };
}
