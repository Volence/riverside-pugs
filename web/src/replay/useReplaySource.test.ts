import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/preact';
import { useReplaySource } from './source';
import {
  encodeHeader, encodeFrame, PLAYER_SLOTS, VERSION,
  type ReplayHeader, type Frame,
} from '../../../src/replayFormat';

/* useReplaySource's fetch/polling lifecycle, as opposed to appendChunk's pure
 * offset arithmetic covered in source.test.ts. Findings 1 and 2 (fix round)
 * both live in the polling loop and would not show up in any test of the pure
 * functions, so they need the hook actually mounted and its timers driven. */

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1_785_956_274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    infectedMask: 0,
    sidesKnown: false,
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function fileResponse(bytes: Uint8Array, closed: boolean): Response {
  return {
    ok: true,
    headers: { get: (h: string) => (h === 'X-Replay-Closed' ? (closed ? '1' : '0') : null) },
    arrayBuffer: async () => toArrayBuffer(bytes),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useReplaySource polling after a closed response', () => {
  it('keeps polling a live spec even after its current file reports closed', async () => {
    const name = `pug_${TOKEN}_0_1.rpl`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/replays/live/')) return jsonResponse({ filename: name, closed: false });
      // The file itself is closed (round over), but the session token is not.
      return fileResponse(new Uint8Array(0), true);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useReplaySource({ kind: 'live', token: TOKEN }));

    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirstTick = fetchMock.mock.calls.length;
    expect(callsAfterFirstTick).toBeGreaterThan(0);

    // A live spec must not give up just because this round's file closed:
    // the session may still be running and about to hand out a new file.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirstTick);
  });

  it('stops polling a file spec once it reports closed', async () => {
    const fetchMock = vi.fn(async () => fileResponse(new Uint8Array(0), true));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useReplaySource({ kind: 'file', name: `pug_${TOKEN}_0_1.rpl` }));

    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirstTick = fetchMock.mock.calls.length;
    expect(callsAfterFirstTick).toBeGreaterThan(0);

    // A finished file has nothing more to say; polling forever would just be
    // waste on somebody's open tab.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstTick);
  });
});

describe('useReplaySource cursor across a live round change', () => {
  it('asks the new file for since=0, not the previous file\'s cursor', async () => {
    const nameA = `pug_${TOKEN}_0_1.rpl`;
    const nameB = `pug_${TOKEN}_1_1.rpl`;
    // A real header+frame so the first file's cursor moves well past 0. If the
    // bug is present, the next round's first fetch reuses this stale offset.
    const chunkA = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);

    let liveCalls = 0;
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith('/api/replays/live/')) {
        liveCalls += 1;
        // First poll resolves round 0; every poll after that has moved on to
        // round 1, exactly the round-change condition this hook exists for.
        return jsonResponse({ filename: liveCalls === 1 ? nameA : nameB, closed: false });
      }
      if (url.includes(encodeURIComponent(nameA))) return fileResponse(chunkA, false);
      return fileResponse(new Uint8Array(0), false);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useReplaySource({ kind: 'live', token: TOKEN }));

    await vi.advanceTimersByTimeAsync(0); // resolves nameA, fetches its chunk
    await vi.advanceTimersByTimeAsync(1000); // resolves nameB: a round change

    const nameBFetch = urls.find((u) => u.includes(encodeURIComponent(nameB)));
    expect(nameBFetch).toBeDefined();
    expect(nameBFetch).toContain('since=0');
  });

  // The same round change for a ranked match, where the server reports an
  // (ordinal, half) pair instead of a filename because the filename carries
  // the match token. The cursor must reset on a change of that pair exactly
  // as it does on a change of filename, and the bytes must come from the
  // by-id route, never from a name.
  it('resets the cursor when a live match reports a new (ordinal, half)', async () => {
    const chunkA = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);

    let liveCalls = 0;
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith('/api/replays/live/match/')) {
        liveCalls += 1;
        // Round 0 half 1 on the first poll, then half 2: a round change.
        return jsonResponse({ ordinal: 0, half: liveCalls === 1 ? 1 : 2, closed: false });
      }
      if (url.startsWith('/api/replays/match/7/0/1')) return fileResponse(chunkA, false);
      return fileResponse(new Uint8Array(0), false);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useReplaySource({ kind: 'live-match', matchId: 7 }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    // The first round's bytes moved the cursor well past 0.
    expect(urls).toContain('/api/replays/match/7/0/1?since=0');
    const halfTwo = urls.find((u) => u.startsWith('/api/replays/match/7/0/2'));
    expect(halfTwo).toBeDefined();
    expect(halfTwo).toContain('since=0');
    // No filename, and therefore no token, was ever asked for.
    expect(urls.some((u) => u.includes('/api/replays/file/'))).toBe(false);
    expect(urls.some((u) => u.includes(TOKEN))).toBe(false);
  });
  // What the game is doing rides on the live answer. The viewer has nothing
  // to draw while the game is paused or readying up, so this is the only way
  // it can say so instead of showing a frozen frame.
  it('surfaces the phase a live match reports', async () => {
    const chunkA = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const phase = { state: 'paused', team: 'a', limit: 120, leave: false, sinceMs: 1_700_000_000_000 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/replays/live/match/')) return jsonResponse({ ordinal: 0, half: 1, closed: false, phase });
      return fileResponse(chunkA, false);
    }));

    const { result } = renderHook(() => useReplaySource({ kind: 'live-match', matchId: 7 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.current.phase).toEqual(phase);
  });

  it('reports no phase for a saved round', async () => {
    const chunkA = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse(chunkA, true)));
    const { result } = renderHook(() => useReplaySource({ kind: 'match', matchId: 7, ordinal: 0, half: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.current.phase).toBeNull();
  });
});

describe('useReplaySource behind the round being played', () => {
  const chunk = () => concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
  const SINCE = 1_700_000_000_000;

  it('reports how long the view has been behind when it reads an older round', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/replays/live/match/')) {
        return jsonResponse({ ordinal: 0, half: 1, closed: true, current: { ordinal: 1, half: 1, sinceMs: SINCE } });
      }
      return fileResponse(chunk(), true);
    }));
    const { result } = renderHook(() => useReplaySource({ kind: 'live-match', matchId: 7 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.current.behindSinceMs).toBe(SINCE);
  });

  it('is not behind while it reads the round being played', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/replays/live/match/')) {
        return jsonResponse({ ordinal: 1, half: 1, closed: false, current: { ordinal: 1, half: 1, sinceMs: SINCE } });
      }
      return fileResponse(chunk(), false);
    }));
    const { result } = renderHook(() => useReplaySource({ kind: 'live-match', matchId: 7 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.current.behindSinceMs).toBeNull();
  });

  it('fetches no bytes and raises no error when the round being played has no file yet, and keeps asking', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ ordinal: null, half: null, closed: false, current: { ordinal: 0, half: 1, sinceMs: SINCE } });
    }));
    const { result } = renderHook(() => useReplaySource({ kind: 'live-match', matchId: 7 }));
    await vi.advanceTimersByTimeAsync(0);
    // A single post-mount state batch (no round to fetch bytes for, so no
    // second network round trip) only settles the DOM; Preact still defers
    // flushing the *effect* that copies it into `result.current` to its
    // usual passive-effect tick, which needs a nonzero fake-timer advance to
    // fire (unlike the other cases in this file, whose extra fetch round
    // trip happens to nudge that flush along for free).
    await vi.advanceTimersByTimeAsync(40);
    expect(result.current.behindSinceMs).toBe(SINCE);
    expect(result.current.error).toBeNull();
    expect(result.current.header).toBeNull();
    expect(urls.some((u) => u.startsWith('/api/replays/match/'))).toBe(false);
    const before = urls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(urls.length).toBeGreaterThan(before);
  });
});

