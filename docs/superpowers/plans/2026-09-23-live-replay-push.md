# Live Replay Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every game server posts the round it is recording to the site once a second, so the live viewer follows a match on any server, and the page never says "Round over" while a round is being played.

**Architecture:** The plugin keeps every byte of the round the site has not confirmed in a ring buffer (`plugin/pug-livepush.inc`) and posts it with REST in Pawn from the confirmed offset, one request at a time. The site (`src/replayPush.ts`, `POST /api/replays/push`) appends a batch to a live copy in its own live directory only when the batch starts exactly at the copy's length, so the copy is always an exact prefix of the real file. The live view reads whichever copy of a round is further along (live directory or replay directory), and the live route reports the round the plugin says is being played so the viewer can say "catching up" or "not available" instead of "Round over".

**Tech Stack:** TypeScript, fastify 5, better-sqlite3, vitest 4, Preact; SourcePawn 1.12 (spcomp via wine), REST in Pawn 1.3.2 (`rip.ext.so`, already installed on all four servers and the local test server).

**Spec:** `docs/superpowers/specs/2026-09-23-live-replay-push-design.md`. Read it before any task. The owner's rulings in it are fixed: every server pushes (Dallas included), Approach A (one HTTPS request per second with REST in Pawn), CPU and tick timing measured not assumed, no per-server streaming setup.

## Global Constraints

- **Run the FULL suite (`npx vitest run`) and `npm run typecheck` at the end of every task, not only the task's own test file.** Known noise that is not yours: ECONNREFUSED lines, the `tests/logAuthWiring.test.ts` flake, and `tests/server.test.ts`'s malformed-URL case in a worktree without `dist/` (run `npm run build` once to silence it).
- **Never use `git stash`.** To see a test fail against the old code, commit your work in progress as a temporary WIP commit and amend it later. Never reset, never touch `master`.
- **No em dashes anywhere**: code, comments, tests, commit messages, docs. Rewrite the sentence instead of swapping the character.
- **Nothing is deployed, staged or sent over rcon by an implementer.** No `deploy-web.sh`, no `plugin/stage.sh`, no rcon to any production box. The local test server and a local site are fine, and only in the "After the last task" section.
- **The token never leaves the server side.** The push endpoint answers only `{ length }` or `{ error }`, never the token or a filename. Live files are never reachable by name: they are read only through the by-match-id routes, which already blank the header's token on the wire (`sendSlice` in `src/routes/replays.ts`). Never log a token.
- **Only live matches accept data.** A token whose match is unknown, `completed` or `aborted` gets the same 404, so the endpoint does not say which tokens exist.
- **Body caps:** fastify refuses a push body over `PUSH_BODY_LIMIT` (128 KiB) with 413 before parsing; a decoded batch over `PUSH_MAX_DATA_BYTES` (64 KiB) is 413; no live file grows past `PUSH_MAX_FILE_BYTES` (64 MiB).
- **The offset rule is the integrity guarantee:** a batch is appended only when `offset` equals the live file's length; a batch that lies wholly inside what is already written is answered with the length and nothing is written; every other offset is refused with 409 and the length. No per-batch signature (spec section 4).
- **The 10-second anti-ghosting delay (`DEFAULT_DELAY_MS` in `src/replayTail.ts`) is not touched.** It keys off the live file's mtime, which is the arrival time of the last batch.
- **Recording is unchanged when pushing is off.** With `sm_pug_live_push 0` (the default) or without REST in Pawn, the plugin writes byte for byte the file it writes today, and loads where `rip.ext.so` is missing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `replayLiveDir`, from `REPLAY_LIVE_DIR`, default `replays-live` beside the database. |
| `src/replayFormat.ts` (modify) | Export the three header offsets the push code patches and reads. |
| `src/replayPush.ts` (create) | `parsePush` (validate a request body), `applyPush` (the offset rule against the live file), `pruneLiveFiles` (cleanup). No fastify, no HTTP. |
| `src/routes/replays.ts` (modify) | `POST /api/replays/push`; the live and by-match routes read the further copy; the live route reports the round in progress. |
| `src/replaySessions.ts` (modify) | `listSessions` and `currentFileFor` merge the live directory; `resolveFurther`. |
| `src/liveView.ts` (modify) | `roundInProgress`: the round the plugin says is being played. |
| `src/server.ts` (modify) | Pass `liveDir` to the replay routes; the live file prune timer. |
| `web/src/replay/source.ts` (modify) | Read `current` from the live answer, expose `behindSinceMs`, accept an answer with no round. |
| `web/src/replay/ReplayHud.tsx`, `TheaterStatus.tsx`, `Viewer.tsx` (modify) | `liveStatusText` says "catching up" then "not available", never "Round over" during a live round. |
| `plugin/include/ripext.inc`, `plugin/include/ripext/http.inc`, `plugin/include/ripext/json.inc` (create, vendored) | REST in Pawn 1.3.2's own includes, unmodified. |
| `plugin/pug-livepush.inc` (create) | Ring buffer, the 1 s timer, one request in flight, resume, close, cvars. |
| `plugin/pug-match.sp`, `plugin/pug-leave.inc`, `plugin/build.sh` (modify) | Four hook calls in the recorder, optional natives, status line, build copies. |

---

### Task 1: The live file store

**Files:**
- Modify: `src/config.ts` (interface `Config` and `loadConfig`)
- Modify: `src/replayFormat.ts` (after `TOKEN_OFFSET`, line 76)
- Create: `src/replayPush.ts`
- Test: `tests/replayPush.test.ts` (create), `tests/config.test.ts` (add a describe)

**Interfaces:**
- Produces:

```ts
// src/config.ts
interface Config { /* ... */ replayLiveDir: string }
// src/replayFormat.ts
export const STARTED_UNIX_OFFSET: number;   // 76
export const INDEX_OFFSET_OFFSET: number;   // 80 (indexOffset, then indexCount at 84)
export const FRAME_COUNT_OFFSET: number;    // 152
// src/replayPush.ts
export const PUSH_MAX_DATA_BYTES = 65536;
export const PUSH_BODY_LIMIT = 131072;
export const PUSH_MAX_FILE_BYTES = 67108864;
export interface FinalPatch { indexOffset: number; indexCount: number; frameCount: number }
export interface PushBatch { token: string; ordinal: number; half: 1 | 2; offset: number; closed: boolean; data: Buffer; final: FinalPatch | null }
export type ParsedPush = { ok: true; batch: PushBatch } | { ok: false; status: 400 | 413; error: string };
export type PushResult = { status: 200 | 409; length: number } | { status: 400; error: string };
export function liveFileName(token: string, ordinal: number, half: number): string;
export function parsePush(body: unknown): ParsedPush;
export function applyPush(liveDir: string, batch: PushBatch): PushResult;
```

The request body the plugin sends (Task 7) is `{ token, ordinal, half, offset, closed, data, final? }`: `ordinal` and `half` name the file exactly as the plugin names it (`pug_<token>_<ordinal>_<half>.rpl`), `offset` is the file byte `data` starts at, `data` is base64, and `final` (only with `closed: true`) carries the three header values `RplClose` patches into the real file after the fact (`plugin/pug-match.sp:1270-1281`), so the site can patch its copy the same way.

- [ ] **Step 1: Write the failing tests**

Add to `tests/config.test.ts`:

```ts
describe('replayLiveDir', () => {
  it('defaults to replays-live beside the database, and takes REPLAY_LIVE_DIR', () => {
    expect(loadConfig({}).replayLiveDir).toBe('data/replays-live');
    expect(loadConfig({ DB_PATH: '/srv/pug/data/pug.db' }).replayLiveDir).toBe('/srv/pug/data/replays-live');
    expect(loadConfig({ REPLAY_LIVE_DIR: ' /mnt/live ' }).replayLiveDir).toBe('/mnt/live');
  });
});
```

Create `tests/replayPush.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePush, applyPush, liveFileName, PUSH_MAX_DATA_BYTES, type PushBatch,
} from '../src/replayPush.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, PLAYER_SLOTS,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN = 'c'.repeat(32);

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

/** Header plus `n` empty frames, as the writer has it before close: 160 + 168n bytes. */
function roundBytes(n: number, over: Partial<ReplayHeader> = {}): Buffer {
  return Buffer.concat([
    encodeHeader(header(over)),
    ...Array.from({ length: n }, (_, i) => encodeFrame(emptyFrame(i * 100))),
  ]);
}

function batch(offset: number, data: Buffer, over: Partial<PushBatch> = {}): PushBatch {
  return { token: TOKEN, ordinal: 0, half: 1, offset, closed: false, data, final: null, ...over };
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: TOKEN, ordinal: 0, half: 1, offset: 0, closed: false,
    data: roundBytes(1).toString('base64'), ...over,
  };
}

let dir: string;
let liveDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rplpush-'));
  // Not created here: applyPush must create it on first use.
  liveDir = join(dir, 'live');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const livePath = () => join(liveDir, liveFileName(TOKEN, 0, 1));

describe('parsePush', () => {
  it('accepts a well formed batch and decodes its data', () => {
    const r = parsePush(body());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch).toMatchObject({ token: TOKEN, ordinal: 0, half: 1, offset: 0, closed: false, final: null });
    expect(r.batch.data.equals(roundBytes(1))).toBe(true);
  });

  it('refuses anything malformed with 400', () => {
    for (const bad of [
      null, [], 'x',
      body({ token: 'C'.repeat(32) }), body({ token: 'c'.repeat(31) }),
      body({ ordinal: -1 }), body({ ordinal: 1.5 }), body({ ordinal: 1000 }),
      body({ half: 3 }), body({ half: '1' }),
      body({ offset: -1 }), body({ offset: 0.5 }),
      body({ closed: 'yes' }),
      body({ data: 'abc' }), body({ data: 'ab=c' }), body({ data: 42 }),
      body({ data: '' }),
      body({ final: { indexOffset: 0, indexCount: 0, frameCount: 0 } }),
      body({ closed: true, final: { indexOffset: -1, indexCount: 0, frameCount: 0 } }),
      body({ closed: true, final: 'x' }),
    ]) {
      expect(parsePush(bad)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('accepts an empty batch only when it closes the round', () => {
    expect(parsePush(body({ data: '', closed: true })).ok).toBe(true);
  });

  it('refuses a batch over the data cap, and a file over the size cap, with 413', () => {
    const big = Buffer.alloc(PUSH_MAX_DATA_BYTES + 3).toString('base64');
    expect(parsePush(body({ data: big }))).toMatchObject({ ok: false, status: 413 });
    expect(parsePush(body({ offset: 64 * 1024 * 1024 }))).toMatchObject({ ok: false, status: 413 });
  });

  it('carries the final header values of a closing batch', () => {
    const r = parsePush(body({ closed: true, final: { indexOffset: 3520, indexCount: 2, frameCount: 20 } }));
    expect(r).toMatchObject({ ok: true, batch: { closed: true, final: { indexOffset: 3520, indexCount: 2, frameCount: 20 } } });
  });
});

describe('applyPush', () => {
  const whole = roundBytes(20); // 3520 bytes

  it('appends batches in order and keeps the live copy an exact prefix of the real file', () => {
    expect(applyPush(liveDir, batch(0, whole.subarray(0, 1000)))).toEqual({ status: 200, length: 1000 });
    expect(readFileSync(livePath()).equals(whole.subarray(0, 1000))).toBe(true);
    expect(applyPush(liveDir, batch(1000, whole.subarray(1000, 2500)))).toEqual({ status: 200, length: 2500 });
    expect(applyPush(liveDir, batch(2500, whole.subarray(2500)))).toEqual({ status: 200, length: 3520 });
    expect(readFileSync(livePath()).equals(whole)).toBe(true);
  });

  it('refuses a gap with the current length, and the resume from that length lands', () => {
    applyPush(liveDir, batch(0, whole.subarray(0, 1000)));
    expect(applyPush(liveDir, batch(2500, whole.subarray(2500)))).toEqual({ status: 409, length: 1000 });
    expect(applyPush(liveDir, batch(1000, whole.subarray(1000)))).toEqual({ status: 200, length: 3520 });
    expect(readFileSync(livePath()).equals(whole)).toBe(true);
  });

  it('refuses a batch that overlaps and runs past the end, writing nothing', () => {
    applyPush(liveDir, batch(0, whole.subarray(0, 1000)));
    expect(applyPush(liveDir, batch(500, whole.subarray(500, 1500)))).toEqual({ status: 409, length: 1000 });
    expect(statSync(livePath()).size).toBe(1000);
  });

  it('answers a batch it already has with the length, without writing', () => {
    applyPush(liveDir, batch(0, whole.subarray(0, 1000)));
    utimesSync(livePath(), 1_000_000, 1_000_000);
    expect(applyPush(liveDir, batch(0, whole.subarray(0, 1000)))).toEqual({ status: 200, length: 1000 });
    expect(applyPush(liveDir, batch(160, whole.subarray(160, 600)))).toEqual({ status: 200, length: 1000 });
    // Untouched: the anti-ghosting delay keys off this mtime.
    expect(statSync(livePath()).mtimeMs).toBe(1_000_000_000);
  });

  it('refuses a first batch that is not a whole header, or whose header names another round', () => {
    expect(applyPush(liveDir, batch(0, whole.subarray(0, 100)))).toMatchObject({ status: 400 });
    expect(applyPush(liveDir, batch(0, roundBytes(1, { token: 'd'.repeat(32) })))).toMatchObject({ status: 400 });
    expect(applyPush(liveDir, batch(0, roundBytes(1, { half: 2 })))).toMatchObject({ status: 400 });
  });

  it('writes the index and frame count into the header on close, so the copy equals the finished file', () => {
    const index = Buffer.alloc(16);
    index.writeUInt32LE(0, 0); index.writeUInt32LE(160, 4);
    index.writeUInt32LE(1000, 8); index.writeUInt32LE(1840, 12);
    const finished = Buffer.concat([
      roundBytes(20, { indexOffset: 3520, indexCount: 2, frameCount: 20 }), index,
    ]);
    const final = { indexOffset: 3520, indexCount: 2, frameCount: 20 };
    applyPush(liveDir, batch(0, whole));
    expect(applyPush(liveDir, batch(3520, index, { closed: true, final }))).toEqual({ status: 200, length: 3536 });
    expect(readFileSync(livePath()).equals(finished)).toBe(true);
    expect(decodeHeader(readFileSync(livePath()))?.frameCount).toBe(20);
    // The same closing batch again (its reply was lost): same answer, same bytes.
    expect(applyPush(liveDir, batch(3520, index, { closed: true, final }))).toEqual({ status: 200, length: 3536 });
    expect(readFileSync(livePath()).equals(finished)).toBe(true);
  });

  it('closes with an empty batch when every byte is already there', () => {
    applyPush(liveDir, batch(0, whole));
    const final = { indexOffset: 0, indexCount: 0, frameCount: 20 };
    expect(applyPush(liveDir, batch(3520, Buffer.alloc(0), { closed: true, final }))).toEqual({ status: 200, length: 3520 });
    expect(decodeHeader(readFileSync(livePath()))?.frameCount).toBe(20);
  });

  it('ignores a final whose index lies outside the file', () => {
    applyPush(liveDir, batch(0, whole));
    const final = { indexOffset: 99_999, indexCount: 4, frameCount: 20 };
    applyPush(liveDir, batch(3520, Buffer.alloc(0), { closed: true, final }));
    expect(decodeHeader(readFileSync(livePath()))?.frameCount).toBe(0);
  });

  it('starts the copy again when the round was restarted under the same name', () => {
    applyPush(liveDir, batch(0, roundBytes(5, { startedUnix: 1000 })));
    const again = roundBytes(2, { startedUnix: 2000 });
    expect(applyPush(liveDir, batch(0, again))).toEqual({ status: 200, length: again.length });
    expect(readFileSync(livePath()).equals(again)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/replayPush.test.ts tests/config.test.ts`
Expected: FAIL, `Cannot find module '../src/replayPush.js'` and `replayLiveDir` undefined.

- [ ] **Step 3: Implement**

`src/config.ts`: add to `Config`, after `replayDir`:

```ts
  /** Where live replay bytes pushed by the game servers are kept while a
   *  round is played. The site's own directory, not the replay directory: on
   *  Dallas the plugin writes its own file into that one, and a pushed copy
   *  beside it must never race it. Created on first push. */
  replayLiveDir: string;
```

and in `loadConfig`, after `ticketAttachmentsDir`:

```ts
    replayLiveDir: env.REPLAY_LIVE_DIR?.trim() || join(dirname(dbPath), 'replays-live'),
```

`src/replayFormat.ts`: after the `TOKEN_OFFSET` export (line 76) add:

```ts
/** Header fields the live push reads or patches. The writer patches the
 *  index fields and the frame count when it closes a file. */
export const STARTED_UNIX_OFFSET: number = OFF.startedUnix;
export const INDEX_OFFSET_OFFSET: number = OFF.indexOffset;
export const FRAME_COUNT_OFFSET: number = OFF.frameCount;
```

Create `src/replayPush.ts`:

```ts
import {
  closeSync, mkdirSync, openSync, readSync, statSync, truncateSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  decodeHeader, HEADER_BYTES, INDEX_RECORD_BYTES,
  STARTED_UNIX_OFFSET, INDEX_OFFSET_OFFSET, FRAME_COUNT_OFFSET,
} from './replayFormat.js';

/**
 * Live replay bytes pushed by a game server.
 *
 * The site keeps a copy of the round's file in its live directory that is
 * always an exact prefix of the real file. That is the whole integrity
 * argument: a batch is written only when it starts exactly where the copy
 * ends, so a lost, repeated or reordered request can never leave a hole or a
 * duplicate, and the plugin resumes from whatever length it is told.
 */

/** Largest decoded batch accepted. The plugin sends at most 48 KiB. */
export const PUSH_MAX_DATA_BYTES = 64 * 1024;
/** Request body cap, enforced by fastify before parsing. Base64 of the data
 *  cap is 87,384 characters; the rest is room for the other fields. */
export const PUSH_BODY_LIMIT = 128 * 1024;
/** No live file grows past this. The plugin's own per-round cap
 *  (sm_pug_replay_max_mb) defaults to 64 MB, and a full round is 10 to 15. */
export const PUSH_MAX_FILE_BYTES = 64 * 1024 * 1024;

const TOKEN_RE = /^[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface FinalPatch { indexOffset: number; indexCount: number; frameCount: number }
export interface PushBatch {
  token: string;
  ordinal: number;
  half: 1 | 2;
  offset: number;
  closed: boolean;
  data: Buffer;
  final: FinalPatch | null;
}
export type ParsedPush = { ok: true; batch: PushBatch } | { ok: false; status: 400 | 413; error: string };
export type PushResult = { status: 200 | 409; length: number } | { status: 400; error: string };

function isU32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;
}

export function liveFileName(token: string, ordinal: number, half: number): string {
  return `pug_${token}_${ordinal}_${half}.rpl`;
}

/** Validate a request body. Nothing here touches the disk or the database. */
export function parsePush(body: unknown): ParsedPush {
  const bad = (error: string): ParsedPush => ({ ok: false, status: 400, error });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('expected a JSON object');
  const b = body as Record<string, unknown>;
  const { token, ordinal, half, offset, closed, data } = b;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return bad('bad token');
  if (!isU32(ordinal) || ordinal > 999) return bad('bad ordinal');
  if (half !== 1 && half !== 2) return bad('bad half');
  if (!isU32(offset)) return bad('bad offset');
  if (closed !== undefined && typeof closed !== 'boolean') return bad('bad closed');
  const isClosed = closed === true;
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64_RE.test(data)) return bad('bad data');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > PUSH_MAX_DATA_BYTES) return { ok: false, status: 413, error: 'batch too large' };
  if (bytes.length === 0 && !isClosed) return bad('empty batch');
  if (offset + bytes.length > PUSH_MAX_FILE_BYTES) return { ok: false, status: 413, error: 'file too large' };

  let final: FinalPatch | null = null;
  if (b.final !== undefined && b.final !== null) {
    if (!isClosed) return bad('final without closed');
    if (typeof b.final !== 'object' || Array.isArray(b.final)) return bad('bad final');
    const f = b.final as Record<string, unknown>;
    if (!isU32(f.indexOffset) || !isU32(f.indexCount) || !isU32(f.frameCount)) return bad('bad final');
    final = { indexOffset: f.indexOffset, indexCount: f.indexCount, frameCount: f.frameCount };
  }
  return { ok: true, batch: { token, ordinal, half, offset, closed: isClosed, data: bytes, final } };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readU32(path: string, at: number): number | null {
  const buf = Buffer.alloc(4);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    return readSync(fd, buf, 0, 4, at) === 4 ? buf.readUInt32LE(0) : null;
  } finally {
    closeSync(fd);
  }
}

/** Write the values RplClose patches into the real file's header, so the
 *  copy ends byte for byte equal to it. Only into a whole header, and only an
 *  index that lies inside the file: a bad patch would make a seek jump into
 *  nonsense, and skipping it only makes seeking slow. */
function patchFinal(path: string, f: FinalPatch, length: number): void {
  if (length < HEADER_BYTES) return;
  if (f.indexCount > 0 && f.indexOffset + f.indexCount * INDEX_RECORD_BYTES > length) return;
  const idx = Buffer.alloc(8);
  idx.writeUInt32LE(f.indexOffset, 0);
  idx.writeUInt32LE(f.indexCount, 4);
  const frames = Buffer.alloc(4);
  frames.writeUInt32LE(f.frameCount, 0);
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, idx, 0, 8, INDEX_OFFSET_OFFSET);
    writeSync(fd, frames, 0, 4, FRAME_COUNT_OFFSET);
  } finally {
    closeSync(fd);
  }
}

/**
 * Apply one batch to the live copy. Synchronous on purpose: Node runs one
 * handler at a time, so the length read here cannot change before the write.
 */
export function applyPush(liveDir: string, b: PushBatch): PushResult {
  mkdirSync(liveDir, { recursive: true });
  const path = join(liveDir, liveFileName(b.token, b.ordinal, b.half));
  let length = sizeOf(path);

  if (b.offset === 0 && b.data.length > 0) {
    // The first batch carries the header. It must be whole, and it must name
    // the round it was pushed under.
    if (b.data.length < HEADER_BYTES) return { status: 400, error: 'the first batch must carry the whole header' };
    const h = decodeHeader(b.data);
    if (!h || h.token !== b.token || h.half !== b.half) {
      return { status: 400, error: 'the header does not match the batch' };
    }
    // A round restarted under the same name: the plugin reopened its file
    // from the top, so the copy starts again too. Otherwise the offset rule
    // would refuse this round for good.
    if (length > 0 && readU32(path, STARTED_UNIX_OFFSET) !== h.startedUnix) {
      truncateSync(path, 0);
      length = 0;
    }
  }

  const end = b.offset + b.data.length;
  if (b.offset < length && end <= length) {
    // Already written: a retry whose reply was lost. Answer, write nothing,
    // except the idempotent header patch of a repeated closing batch.
    if (b.closed && b.final && end === length) patchFinal(path, b.final, length);
    return { status: 200, length };
  }
  if (b.offset !== length) return { status: 409, length };

  if (b.data.length > 0) {
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, b.data);
    } finally {
      closeSync(fd);
    }
  }
  if (b.closed && b.final) patchFinal(path, b.final, end);
  return { status: 200, length: end };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/replayPush.test.ts tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS apart from the known noise.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/replayFormat.ts src/replayPush.ts tests/replayPush.test.ts tests/config.test.ts
git commit -m "Keep a live copy of a pushed replay that is always an exact prefix of the real file"
```

---

### Task 2: The push endpoint

**Files:**
- Modify: `src/routes/replays.ts` (imports; `replayRoutes` options at line 224-227; new route)
- Modify: `src/server.ts:1341` (the `replayRoutes` registration)
- Test: `tests/replayPushRoute.test.ts` (create)

**Interfaces:**
- Consumes: `parsePush`, `applyPush`, `PUSH_BODY_LIMIT`, `liveFileName` (Task 1); `Config.replayLiveDir` (Task 1).
- Produces: `replayRoutes(app, opts: { db: DB; replayDir: string; liveDir?: string })`. `POST /api/replays/push` answers 200 `{ length }`, 409 `{ length }`, 400 or 413 `{ error }`, 404 `{ error: 'no live match for that token' }` for an unknown, finished or aborted match, 404 `{ error: 'live push is not configured' }` with no live directory.

- [ ] **Step 1: Write the failing tests** `tests/replayPushRoute.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { replayRoutes } from '../src/routes/replays.js';
import { openDb, type DB } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';
import { liveFileName } from '../src/replayPush.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, PLAYER_SLOTS,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

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

const WHOLE = Buffer.concat([
  encodeHeader(header()),
  ...Array.from({ length: 20 }, (_, i) => encodeFrame(emptyFrame(i * 100))),
]); // 3520 bytes

let dir: string;
let liveDir: string;
let db: DB;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rplpushroute-'));
  liveDir = join(dir, 'live');
  db = openDb(':memory:');
  app = Fastify();
  await app.register(replayRoutes, { db, replayDir: join(dir, 'replays'), liveDir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedMatch(state: string, token = TOKEN): void {
  db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, ?, 'no_mercy', ?)`)
    .run(state, token);
}

function body(offset: number, data: Buffer, over: Record<string, unknown> = {}) {
  return { token: TOKEN, ordinal: 0, half: 1, offset, closed: false, data: data.toString('base64'), ...over };
}

const push = (payload: object) => app.inject({ method: 'POST', url: '/api/replays/push', payload });
const livePath = () => join(liveDir, liveFileName(TOKEN, 0, 1));

describe('POST /api/replays/push', () => {
  it('writes a live match\'s batch and answers with the new length', async () => {
    seedMatch('live');
    const res = await push(body(0, WHOLE.subarray(0, 1000)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ length: 1000 });
    expect(readFileSync(livePath()).equals(WHOLE.subarray(0, 1000))).toBe(true);
    // Neither the token nor a filename comes back.
    expect(res.payload).not.toContain(TOKEN);
    expect(res.payload).not.toContain('.rpl');
  });

  it('refuses an unknown, finished or aborted match with the same 404, writing nothing', async () => {
    const unknown = await push(body(0, WHOLE));
    expect(unknown.statusCode).toBe(404);
    for (const state of ['completed', 'aborted', 'configuring']) {
      db.prepare('DELETE FROM matches').run();
      seedMatch(state);
      const res = await push(body(0, WHOLE));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
    }
    expect(existsSync(livePath())).toBe(false);
  });

  it('refuses a gap with 409 and the length, and accepts the resume', async () => {
    seedMatch('live');
    await push(body(0, WHOLE.subarray(0, 1000)));
    const gap = await push(body(2500, WHOLE.subarray(2500)));
    expect(gap.statusCode).toBe(409);
    expect(gap.json()).toEqual({ length: 1000 });
    const resume = await push(body(1000, WHOLE.subarray(1000)));
    expect(resume.json()).toEqual({ length: 3520 });
    expect(readFileSync(livePath()).equals(WHOLE)).toBe(true);
  });

  it('refuses a malformed batch with 400', async () => {
    seedMatch('live');
    const res = await push(body(0, WHOLE, { half: 3 }));
    expect(res.statusCode).toBe(400);
  });

  it('refuses a body over the cap with 413 before reading it', async () => {
    seedMatch('live');
    const res = await push({ ...body(0, WHOLE), data: 'A'.repeat(140_000) });
    expect(res.statusCode).toBe(413);
    expect(existsSync(livePath())).toBe(false);
  });

  it('patches the header of a closed round', async () => {
    seedMatch('live');
    await push(body(0, WHOLE));
    const res = await push(body(3520, Buffer.alloc(0), {
      closed: true, final: { indexOffset: 0, indexCount: 0, frameCount: 20 },
    }));
    expect(res.json()).toEqual({ length: 3520 });
    expect(decodeHeader(readFileSync(livePath()))?.frameCount).toBe(20);
  });

  it('is off when no live directory is configured', async () => {
    const off = Fastify();
    await off.register(replayRoutes, { db, replayDir: join(dir, 'replays') });
    await off.ready();
    seedMatch('live');
    const res = await off.inject({ method: 'POST', url: '/api/replays/push', payload: body(0, WHOLE) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'live push is not configured' });
    await off.close();
  });

  it('is registered on the real server with the configured live directory', async () => {
    const real = await buildServer({
      config: loadConfig({ REPLAY_DIR: join(dir, 'replays'), REPLAY_LIVE_DIR: liveDir }),
      db: openDb(':memory:'),
      orchestrator: stubOrchestrator(),
      serverExec: async () => {},
    });
    const res = await real.inject({ method: 'POST', url: '/api/replays/push', payload: body(0, WHOLE) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no live match for that token' });
    await real.close();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/replayPushRoute.test.ts`
Expected: FAIL, 404 from fastify's not-found handler (route missing) with a different body.

- [ ] **Step 3: Implement**

`src/routes/replays.ts`: add the import

```ts
import { applyPush, parsePush, PUSH_BODY_LIMIT } from '../replayPush.js';
```

change the options and destructuring of `replayRoutes`:

```ts
export async function replayRoutes(
  app: FastifyInstance, opts: { db: DB; replayDir: string; liveDir?: string },
): Promise<void> {
  const { db, replayDir, liveDir = '' } = opts;
```

and add the route as the first one inside `replayRoutes`:

```ts
  /**
   * Live replay bytes from a game server, about once a second per match.
   *
   * The match's token is the credential: it is secret, it only travels over
   * HTTPS (or stays inside the Dallas box), and only a match in the 'live'
   * state accepts data. An unknown, finished or aborted token gets the same
   * 404 so the answer says nothing about which tokens exist. The reply is a
   * length or an error and never names a file. See src/replayPush.ts for the
   * offset rule that keeps the live copy an exact prefix of the real file.
   */
  app.post('/api/replays/push', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!liveDir) return reply.code(404).send({ error: 'live push is not configured' });
    const parsed = parsePush(req.body);
    if (!parsed.ok) return reply.code(parsed.status).send({ error: parsed.error });
    const live = db
      .prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
      .get(parsed.batch.token) as { id: number } | undefined;
    if (!live) return reply.code(404).send({ error: 'no live match for that token' });
    const result = applyPush(liveDir, parsed.batch);
    if (result.status === 400) return reply.code(400).send({ error: result.error });
    return reply.code(result.status).send({ length: result.length });
  });
```

`src/server.ts:1341`:

```ts
  await app.register(replayRoutes, {
    db: deps.db, replayDir: deps.config.replayDir, liveDir: deps.config.replayLiveDir,
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/replayPushRoute.test.ts tests/replayRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck.**

- [ ] **Step 6: Commit**

```bash
git add src/routes/replays.ts src/server.ts tests/replayPushRoute.test.ts
git commit -m "Accept live replay bytes from a live match's server at /api/replays/push"
```

---

### Task 3: The live view reads whichever copy is further along

**Files:**
- Modify: `src/replaySessions.ts` (`listSessions` at 87-121, `currentFileFor` at 148-159, new `resolveFurther`)
- Modify: `src/routes/replays.ts` (live route at 251, by-match route at 296-298, `liveRoundFor` at 327)
- Test: `tests/replaySessions.test.ts`, `tests/replayRoutes.test.ts`

**Interfaces:**
- Consumes: `replayRoutes` `liveDir` option (Task 2).
- Produces:

```ts
export function listSessions(dir: string, nowMs: number, db?: DB, liveDir?: string): ReplaySession[];
export function currentFileFor(dir: string, token: string, nowMs: number, db?: DB, delayMs?: number, liveDir?: string): ReplayFileInfo | null;
export function resolveFurther(replayDir: string, liveDir: string, filename: string, nowMs: number): { path: string; info: ReplayFileInfo } | null;
```

"Further along" is more bytes. On a tie the replay directory wins, so once a pulled final file (written by the pull jobs with a temp file and a rename, so never half-written) is as long as the pushed copy, it takes over; on Dallas, where the plugin's own file is in the replay directory, the viewer can never go backwards between the two.

- [ ] **Step 1: Write the failing tests**

In `tests/replaySessions.test.ts`, add `mkdirSync` to the `node:fs` import and `resolveFurther` to the `../src/replaySessions.js` import, then add:

```ts
function writeIn(target: string, name: string, h: ReplayHeader, frames: number, mtimeMs = NOW): void {
  const path = join(target, name);
  writeFileSync(path, Buffer.concat([
    encodeHeader(h), ...Array.from({ length: frames }, (_, i) => encodeFrame(emptyFrame(i * 100))),
  ]));
  const secs = mtimeMs / 1000;
  utimesSync(path, secs, secs);
}

describe('the live directory', () => {
  let live: string;
  beforeEach(() => { live = join(dir, 'live'); mkdirSync(live); });
  const name = `pug_${TOKEN_A}_0_1.rpl`;

  it('finds a round that exists only in the live directory', () => {
    writeIn(live, name, header(), 3);
    expect(currentFileFor(dir, TOKEN_A, NOW, undefined, 0, live)?.filename).toBe(name);
    expect(currentFileFor(dir, TOKEN_A, NOW, undefined, 0)).toBeNull();
  });

  it('prefers the live copy while it is further along', () => {
    writeIn(dir, name, header(), 2);
    writeIn(live, name, header(), 5);
    expect(currentFileFor(dir, TOKEN_A, NOW, undefined, 0, live)?.bytes).toBe(HEADER_BYTES + 5 * 168);
  });

  it('takes the replay directory copy on a tie and once it is longer', () => {
    writeIn(dir, name, header({ frameCount: 5 }), 5);
    writeIn(live, name, header(), 5);
    expect(currentFileFor(dir, TOKEN_A, NOW, undefined, 0, live)?.frameCount).toBe(5);
    writeIn(dir, name, header({ frameCount: 7 }), 7);
    expect(currentFileFor(dir, TOKEN_A, NOW, undefined, 0, live)?.bytes).toBe(HEADER_BYTES + 7 * 168);
  });

  it('resolveFurther picks the longer copy, the replay directory on a tie, and either alone', () => {
    expect(resolveFurther(dir, live, name, NOW)).toBeNull();
    writeIn(live, name, header(), 3);
    expect(resolveFurther(dir, live, name, NOW)?.path).toBe(join(live, name));
    writeIn(dir, name, header(), 3);
    expect(resolveFurther(dir, live, name, NOW)?.path).toBe(join(dir, name));
    writeIn(live, name, header(), 4);
    expect(resolveFurther(dir, live, name, NOW)?.path).toBe(join(live, name));
    expect(resolveFurther(dir, '', name, NOW)?.path).toBe(join(dir, name));
  });
});
```

In `tests/replayRoutes.test.ts`, add `mkdirSync` to the `node:fs` import, give `writeRound` a last parameter `into = dir` (and write to `join(into, name)` instead of `join(dir, name)`), then add:

```ts
describe('the live directory', () => {
  let liveDir: string;
  let liveApp: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    liveDir = join(dir, 'live');
    mkdirSync(liveDir);
    liveApp = Fastify();
    await liveApp.register(replayRoutes, { db, replayDir: dir, liveDir });
    await liveApp.ready();
  });
  afterEach(async () => { await liveApp.close(); });

  function seedLiveMatch(): number {
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`).run(TOKEN);
    return (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
  }

  it('names a round that only the live directory has', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true, VERSION, liveDir);
    const id = seedLiveMatch();
    const res = await liveApp.inject({ url: `/api/replays/live/match/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ordinal: 0, half: 1, closed: true });
  });

  it('serves the round in progress from the live directory, cut off and without the token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false, VERSION, liveDir);
    const id = seedLiveMatch();
    const res = await liveApp.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');
    expect(res.rawPayload.length).toBeGreaterThanOrEqual(HEADER_BYTES);
    expect(res.rawPayload.length).toBeLessThan(HEADER_BYTES + frameBytes(0) * 15);
    expect(res.rawPayload.includes(TOKEN)).toBe(false);
  });

  it('serves whichever copy is further along, even when a match_replays row exists', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 10, 600, true, VERSION, liveDir);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await liveApp.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 10);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/replaySessions.test.ts tests/replayRoutes.test.ts`
Expected: FAIL (`resolveFurther` is not exported; live-only rounds 404).

- [ ] **Step 3: Implement**

`src/replaySessions.ts`: replace `listSessions` with the version below (the grouping, sorting and campaign code after the merge is unchanged), change `currentFileFor`, and add `resolveFurther` after `resolveByName`:

```ts
/** Every replay in one directory, keyed by filename. */
function infosIn(dir: string, nowMs: number): Map<string, ReplayFileInfo> {
  const out = new Map<string, ReplayFileInfo>();
  if (!dir) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const info = readInfo(dir, name, nowMs);
    if (info) out.set(name, info);
  }
  return out;
}

/** Every replay on disk, grouped by the session token in its filename.
 *
 *  With a live directory, a round present in both is represented by the copy
 *  that is further along (more bytes), the replay directory's on a tie: see
 *  resolveFurther.
 *
 *  Never throws. A missing or unreadable directory yields no sessions,
 *  because a browse page returning empty is a far better failure than a
 *  browse page returning 500. */
export function listSessions(dir: string, nowMs: number, db?: DB, liveDir = ''): ReplaySession[] {
  const infos = infosIn(dir, nowMs);
  for (const [name, live] of infosIn(liveDir, nowMs)) {
    const own = infos.get(name);
    if (!own || live.bytes > own.bytes) infos.set(name, live);
  }

  const byToken = new Map<string, ReplayFileInfo[]>();
  for (const info of infos.values()) {
    const list = byToken.get(info.token);
    if (list) list.push(info);
    else byToken.set(info.token, [info]);
  }
  // ... the existing `const out: ReplaySession[] = []` loop and sort, unchanged.
}
```

```ts
export function currentFileFor(
  dir: string, token: string, nowMs: number, db?: DB, delayMs: number = DEFAULT_DELAY_MS,
  liveDir = '',
): ReplayFileInfo | null {
  if ((!dir && !liveDir) || !TOKEN_RE.test(token)) return null;
  const session = listSessions(dir, nowMs, db, liveDir).find((s) => s.token === token);
  // ... the rest unchanged.
}
```

Add one sentence to `currentFileFor`'s doc comment: "A live directory, when given, is merged in as listSessions describes."

```ts
/**
 * Resolve a round by name in both the replay directory and the live
 * directory, and take the copy that is further along.
 *
 * More bytes wins; the replay directory wins a tie. That is what lets the
 * pulled final file take over from the pushed copy the moment it is as long,
 * and what keeps Dallas, where the plugin's own growing file and the pushed
 * copy sit side by side, from ever making the viewer go backwards. Both
 * lookups go through resolveByName, so both get its path hardening.
 */
export function resolveFurther(
  replayDir: string, liveDir: string, filename: string, nowMs: number,
): { path: string; info: ReplayFileInfo } | null {
  const own = resolveByName(replayDir, filename, nowMs);
  const live = liveDir ? resolveByName(liveDir, filename, nowMs) : null;
  if (!own) return live;
  if (!live) return own;
  return live.info.bytes > own.info.bytes ? live : own;
}
```

`src/routes/replays.ts`: import `resolveFurther` beside `resolveByName`. In the live-by-match route, `currentFileFor(replayDir, row.token, Date.now(), db, undefined, liveDir)`. In `/api/replays/match/:id/:ordinal/:half`:

```ts
    const found = row
      ? resolveFurther(replayDir, liveDir, row.filename, now)
      : liveRoundFor(Number(id), ordinal, half, now);
```

and the last line of `liveRoundFor`:

```ts
    return resolveFurther(replayDir, liveDir, `pug_${row.token}_${ord}_${hf}.rpl`, nowMs);
```

Leave `/api/replays/file/:name` and `/api/replays/live/:token` on the replay directory only: standalone sessions never push, and a live file must never be reachable by name.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/replaySessions.test.ts tests/replayRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck.**

- [ ] **Step 6: Commit**

```bash
git add src/replaySessions.ts src/routes/replays.ts tests/replaySessions.test.ts tests/replayRoutes.test.ts
git commit -m "Read whichever copy of a live round is further along, the pushed one or the replay directory's"
```

---

### Task 4: Cleanup of live files

**Files:**
- Modify: `src/replayPush.ts` (add `pruneLiveFiles`)
- Modify: `src/server.ts` (a timer next to `pruneTimer` at ~1112; `clearInterval` in the `onClose` hook at ~1288)
- Test: `tests/replayPush.test.ts` (add a describe)

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `export const LIVE_FILE_MAX_AGE_MS = 86_400_000; export function pruneLiveFiles(db: DB, liveDir: string, replayDir: string, nowMs: number): number` (files removed).

Rule (spec section 2): a live file is deleted once its match is no longer live and the replay directory holds a file of the same name at least as long; any live file untouched for 24 hours is deleted regardless.

- [ ] **Step 1: Write the failing tests** (append to `tests/replayPush.test.ts`; add `mkdirSync`, `writeFileSync`, `existsSync` to the `node:fs` import, `pruneLiveFiles` to the `../src/replayPush.js` import, and `import { openDb, type DB } from '../src/db.js';`)

```ts
describe('pruneLiveFiles', () => {
  const OTHER = 'e'.repeat(32);
  const NOW = Date.now();
  let db: DB;
  let live: string;
  let replays: string;

  beforeEach(() => {
    db = openDb(':memory:');
    live = join(dir, 'live');
    replays = join(dir, 'replays');
    mkdirSync(live);
    mkdirSync(replays);
  });

  function put(target: string, name: string, bytes: number, ageMs = 0): void {
    const path = join(target, name);
    writeFileSync(path, Buffer.alloc(bytes));
    const secs = (NOW - ageMs) / 1000;
    utimesSync(path, secs, secs);
  }
  function seed(state: string, token: string): void {
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, ?, 'no_mercy', ?)`).run(state, token);
  }
  const name = (token: string) => liveFileName(token, 0, 1);

  it('keeps a live match\'s file even when a final copy exists', () => {
    seed('live', TOKEN);
    put(live, name(TOKEN), 100);
    put(replays, name(TOKEN), 200);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(0);
    expect(existsSync(join(live, name(TOKEN)))).toBe(true);
  });

  it('deletes a finished match\'s file once the final copy is at least as long', () => {
    seed('completed', TOKEN);
    put(live, name(TOKEN), 100);
    put(replays, name(TOKEN), 100);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(1);
    expect(existsSync(join(live, name(TOKEN)))).toBe(false);
  });

  it('keeps a finished match\'s file while the final copy is shorter or missing', () => {
    seed('completed', TOKEN);
    seed('aborted', OTHER);
    put(live, name(TOKEN), 100);
    put(replays, name(TOKEN), 50);
    put(live, name(OTHER), 100);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(0);
  });

  it('deletes any live file older than a day, live match or not', () => {
    seed('live', TOKEN);
    put(live, name(TOKEN), 100, 25 * 60 * 60 * 1000);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(1);
  });

  it('leaves other names alone and survives a missing or unset directory', () => {
    put(live, 'notes.txt', 10, 48 * 60 * 60 * 1000);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(0);
    expect(existsSync(join(live, 'notes.txt'))).toBe(true);
    expect(pruneLiveFiles(db, join(dir, 'nope'), replays, NOW)).toBe(0);
    expect(pruneLiveFiles(db, '', replays, NOW)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/replayPush.test.ts`
Expected: FAIL, `pruneLiveFiles` is not exported.

- [ ] **Step 3: Implement**

In `src/replayPush.ts` add `readdirSync` and `unlinkSync` to the `node:fs` import, `import type { DB } from './db.js';`, and:

```ts
const NAME_RE = /^pug_([0-9a-f]{32})_(\d+)_([12])\.rpl$/;

/** A live file untouched this long is deleted whatever its match is doing. */
export const LIVE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete live files nobody needs. A file goes once its match is no longer
 * live and the replay directory holds the same round at least as long (the
 * pulled final file has taken over), and any file goes after a day untouched.
 * Never throws: a failed unlink is logged and retried next run.
 */
export function pruneLiveFiles(db: DB, liveDir: string, replayDir: string, nowMs: number): number {
  if (!liveDir) return 0;
  let names: string[];
  try {
    names = readdirSync(liveDir);
  } catch {
    return 0;
  }
  const liveTokens = new Set(
    (db.prepare("SELECT token FROM matches WHERE state = 'live' AND token IS NOT NULL").all() as { token: string }[])
      .map((r) => r.token),
  );
  let removed = 0;
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const path = join(liveDir, name);
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    let superseded = false;
    if (!liveTokens.has(m[1]) && replayDir) {
      try {
        superseded = statSync(join(replayDir, name)).size >= size;
      } catch {
        superseded = false;
      }
    }
    if (!superseded && nowMs - mtimeMs <= LIVE_FILE_MAX_AGE_MS) continue;
    try {
      unlinkSync(path);
      removed++;
    } catch (err) {
      console.error('[replay] could not delete a live file:', (err as Error).message);
    }
  }
  return removed;
}
```

The log line deliberately prints the error message only, not the path, because the path contains the token.

`src/server.ts`: import `pruneLiveFiles` from `./replayPush.js`; after the `pruneTimer` block (~1116) add:

```ts
  // Live replay copies. Every ten minutes, because a finished match's copy is
  // superseded as soon as the pull job lands its final file, and the live
  // directory should not hold a day of rounds for nothing.
  const livePruneTimer = setInterval(() => {
    try {
      pruneLiveFiles(deps.db, deps.config.replayLiveDir, deps.config.replayDir, Date.now());
    } catch (err) {
      console.error('[replay] live file prune failed:', err);
    }
  }, 10 * 60 * 1000);
  livePruneTimer.unref();
```

and in the `onClose` hook, next to `clearInterval(pruneTimer);`, add `clearInterval(livePruneTimer);`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/replayPush.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck.**

- [ ] **Step 6: Commit**

```bash
git add src/replayPush.ts src/server.ts tests/replayPush.test.ts
git commit -m "Delete a live replay copy once the final file has taken over, or after a day"
```

---

### Task 5: The live route says which round is being played

**Files:**
- Modify: `src/liveView.ts` (add `roundInProgress` after `phaseFor`, ~408)
- Modify: `src/routes/replays.ts` (the `/api/replays/live/match/:id` route, 245-257)
- Test: `tests/roundInProgress.test.ts` (create), `tests/replayRoutes.test.ts`

**Interfaces:**
- Consumes: Task 3's `currentFileFor(..., liveDir)`.
- Produces:

```ts
export interface RoundInProgress { ordinal: number; half: number; sinceMs: number }
export function roundInProgress(db: DB, matchId: number): RoundInProgress | null;
```

and the live route's answer becomes

```ts
{ ordinal: number | null; half: number | null; closed: boolean; phase: LivePhase | null; current: RoundInProgress | null }
```

`current` is the round the plugin says is being played: the newest `match_rounds` row for the match, only while it has `started_at` and no `ended_at`, and only while the reported phase is `live` or `paused` (the heartbeat repeats the phase every 30 s, so a lost ROUND_END datagram cannot leave a round "in progress" for ever). `sinceMs` is that row's `started_at`. The ordinal is the same number the replay file name carries (`infectedMaskFor` already relies on `match_rounds.ordinal` matching the file's ordinal). When the match has no file at all but a round is in progress, the route answers 200 with `ordinal: null` instead of 404, so the viewer can say what is happening. With no file and no round in progress it still 404s.

- [ ] **Step 1: Write the failing tests**

Create `tests/roundInProgress.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { recordPhase, roundInProgress } from '../src/liveView.js';
import type { Phase } from '../src/logParse.js';

const TOKEN = 'a'.repeat(32);
let db: DB;
let id: number;

const phase = (state: Phase['state']): Phase => ({ state, team: null, limit: 0, leave: false, unready: [] });

function round(ordinal: number, half: number, ended: boolean): void {
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at, ended_at)
     VALUES (?, ?, ?, 'a', datetime('now', '-5 seconds'), ${ended ? "datetime('now')" : 'NULL'})`,
  ).run(id, ordinal, half);
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`).run(TOKEN);
  id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
});

describe('roundInProgress', () => {
  it('names the newest unended round while the phase is live', () => {
    round(0, 1, true);
    round(0, 2, false);
    recordPhase(db, TOKEN, phase('live'));
    const r = roundInProgress(db, id);
    expect(r).toMatchObject({ ordinal: 0, half: 2 });
    expect(Math.abs(r!.sinceMs - (Date.now() - 5000))).toBeLessThan(3000);
  });

  it('counts a paused round as in progress', () => {
    round(1, 1, false);
    recordPhase(db, TOKEN, phase('paused'));
    expect(roundInProgress(db, id)).toMatchObject({ ordinal: 1, half: 1 });
  });

  it('is null with no phase, between rounds, and once the newest round has ended', () => {
    round(0, 1, false);
    expect(roundInProgress(db, id)).toBeNull();
    recordPhase(db, TOKEN, phase('roundover'));
    expect(roundInProgress(db, id)).toBeNull();
    recordPhase(db, TOKEN, phase('live'));
    db.prepare("UPDATE match_rounds SET ended_at = datetime('now')").run();
    expect(roundInProgress(db, id)).toBeNull();
  });
});
```

In `tests/replayRoutes.test.ts`: import `type Phase` from `../src/logParse.js`; change the first live-route test's expectation to `expect(res.json()).toEqual({ ordinal: 1, half: 1, closed: false, phase: null, current: null });`; add inside `describe('GET /api/replays/live/match/:id', ...)`:

```ts
  const livePhase = (): Phase => ({ state: 'live', team: null, limit: 0, leave: false, unready: [] });
  function startRound(matchId: number, ordinal: number, half: number): void {
    db.prepare(
      `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at)
       VALUES (?, ?, ?, 'a', datetime('now', '-5 seconds'))`,
    ).run(matchId, ordinal, half);
  }

  it('says which round is being played when the file it serves is an older one', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    recordPhase(db, TOKEN, livePhase());
    startRound(id, 1, 1);
    const body = (await app.inject({ url: `/api/replays/live/match/${id}` })).json();
    expect(body).toMatchObject({ ordinal: 0, half: 1, closed: true, current: { ordinal: 1, half: 1 } });
    expect(typeof body.current.sinceMs).toBe('number');
  });

  it('answers with no round, not 404, when the round being played has no file yet', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    recordPhase(db, TOKEN, livePhase());
    startRound(id, 0, 1);
    const res = await app.inject({ url: `/api/replays/live/match/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ordinal: null, half: null, closed: false, current: { ordinal: 0, half: 1 } });
    expect(res.payload).not.toContain(TOKEN);
  });

  it('reports no current round between rounds', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    recordPhase(db, TOKEN, { ...livePhase(), state: 'roundover' });
    expect((await app.inject({ url: `/api/replays/live/match/${id}` })).json().current).toBeNull();
  });
```

The existing "404s a match with no replay on disk" test stays as it is and must still pass (no phase, so no round in progress).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/roundInProgress.test.ts tests/replayRoutes.test.ts`
Expected: FAIL (`roundInProgress` is not exported; `current` missing).

- [ ] **Step 3: Implement**

`src/liveView.ts`, after `phaseFor`:

```ts
/** The round the plugin says is being played. See roundInProgress. */
export interface RoundInProgress { ordinal: number; half: number; sinceMs: number }

/**
 * The round being played right now, or null between rounds.
 *
 * The newest round row, only while it has started and not ended, and only
 * while the reported phase is live or paused. The phase is the guard against
 * a lost ROUND_END datagram: the heartbeat repeats the phase every thirty
 * seconds, so a round cannot stay "in progress" for longer than that after
 * the game has moved on. The live viewer compares this with the round whose
 * bytes it is reading, which is how the page knows it is behind.
 */
export function roundInProgress(db: DB, matchId: number): RoundInProgress | null {
  const phase = phaseFor(db, matchId);
  if (!phase || (phase.state !== 'live' && phase.state !== 'paused')) return null;
  const row = db
    .prepare(
      `SELECT ordinal, half, started_at, ended_at FROM match_rounds
        WHERE match_id = ? ORDER BY ordinal DESC, half DESC LIMIT 1`,
    )
    .get(matchId) as { ordinal: number; half: number; started_at: string | null; ended_at: string | null } | undefined;
  if (!row || row.started_at === null || row.ended_at !== null) return null;
  return { ordinal: row.ordinal, half: row.half, sinceMs: sqliteToMs(row.started_at) };
}
```

`src/routes/replays.ts`: import `roundInProgress` beside `phaseFor`, and replace the body of `/api/replays/live/match/:id` after the token check with:

```ts
    const matchId = Number(id);
    const info = currentFileFor(replayDir, row.token, Date.now(), db, undefined, liveDir);
    // The round the plugin says is being played. When it is not the round
    // whose bytes are served (the push is behind, or off on that server), the
    // viewer says so rather than presenting an older finished file as the
    // current round.
    const current = roundInProgress(db, matchId);
    if (!info && !current) return reply.code(404).send({ error: 'no replay for that match' });
    return {
      ordinal: info?.ordinal ?? null,
      half: info?.half ?? null,
      closed: info?.closed ?? false,
      phase: phaseFor(db, matchId),
      current,
    };
```

Add to the route's doc comment: "`current` is the round being played (`roundInProgress`), which may be newer than the round served; with no file yet the ordinal and half are null."

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/roundInProgress.test.ts tests/replayRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck.**

- [ ] **Step 6: Commit**

```bash
git add src/liveView.ts src/routes/replays.ts tests/roundInProgress.test.ts tests/replayRoutes.test.ts
git commit -m "Report the round being played on the live route, and answer even when it has no file yet"
```

---

### Task 6: The page never says "Round over" while a round is live

**Files:**
- Modify: `web/src/replay/source.ts` (`useReplaySource`, 114-240)
- Modify: `web/src/replay/ReplayHud.tsx` (`liveStatusText` 45-67, `ReplayHud` props)
- Modify: `web/src/replay/TheaterStatus.tsx` (props)
- Modify: `web/src/replay/Viewer.tsx` (104, 287-288, the `ReplayHud` and `TheaterStatus` elements at ~363 and ~459)
- Test: `web/src/replay/ReplayHud.test.tsx`, `web/src/replay/useReplaySource.test.ts`, `web/src/replay/Viewer.test.tsx`

**Interfaces:**
- Consumes: the live route's `current` (Task 5).
- Produces:

```ts
// source.ts
export interface LiveRound { ordinal: number; half: number; sinceMs: number }
// useReplaySource(...) also returns
behindSinceMs: number | null;
// ReplayHud.tsx
export const CATCH_UP_MS = 30_000;
export function liveStatusText(
  live: boolean, closed: boolean, tMs: number, endMs: number,
  phase?: LivePhase | null, nowMs?: number, names?: Record<string, string>,
  behindSinceMs?: number | null,
): string | null;
```

Rule order in `liveStatusText`: not live gives null; paused, readyup and loading keep their texts (the plugin's word wins); then "behind" wins over the file state. The view is behind when `behindSinceMs` is set (the server reports a round in progress other than the one being read, or no file at all), or when the phase is `live` and the file is closed (timed from `phase.sinceMs`). Behind for under `CATCH_UP_MS` reads "Live view is catching up"; after that, "Live view isn't available for this server right now". Only then the existing texts: open file "Live, 10s delayed", closed file "Round over, catching up" or "Round over, waiting for the next round", which can now appear only when the phase is not `live`.

- [ ] **Step 1: Write the failing tests**

`web/src/replay/ReplayHud.test.tsx`: in `falls back to the file state when the phase is live or unknown`, delete the line `expect(liveStatusText(true, true, 10, 10, phase({ state: 'live' }), NOW)).toBe('Round over, waiting for the next round');` (that behaviour is what this task removes) and add:

```ts
describe('liveStatusText while the view is behind the round being played', () => {
  const NOW = 1_700_000_000_000;
  const phase = (over: Partial<LivePhase>): LivePhase => ({ state: 'live', team: null, limit: 0, leave: false, unready: [], sinceMs: NOW - 5_000, ...over });

  it('says catching up for thirty seconds, then that the view is not available', () => {
    expect(liveStatusText(true, true, 10, 10, phase({}), NOW, {}, NOW - 5_000)).toBe('Live view is catching up');
    expect(liveStatusText(true, false, 10, 10, null, NOW, {}, NOW - 29_999)).toBe('Live view is catching up');
    expect(liveStatusText(true, true, 10, 10, phase({}), NOW, {}, NOW - 30_000))
      .toBe("Live view isn't available for this server right now");
  });

  it('treats a live phase over a finished file as behind, timed from the phase', () => {
    expect(liveStatusText(true, true, 10, 10, phase({ sinceMs: NOW - 5_000 }), NOW)).toBe('Live view is catching up');
    expect(liveStatusText(true, true, 5, 10, phase({ sinceMs: NOW - 40_000 }), NOW))
      .toBe("Live view isn't available for this server right now");
  });

  it('never says Round over while the phase is live', () => {
    for (const closed of [true, false]) {
      for (const [t, end] of [[0, 10], [10, 10]]) {
        for (const behind of [null, NOW - 1_000, NOW - 60_000]) {
          const text = liveStatusText(true, closed, t, end, phase({}), NOW, {}, behind);
          expect(text).not.toMatch(/Round over/);
        }
      }
    }
  });

  it('lets a pause, a ready-up and a load speak over being behind', () => {
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'paused' }), NOW, {}, NOW - 5_000)).toBe('Paused');
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'loading' }), NOW, {}, NOW - 5_000)).toBe('Loading the next map');
  });

  it('still says Round over between rounds', () => {
    expect(liveStatusText(true, true, 10, 10, phase({ state: 'roundover' }), NOW)).toBe('Round over, waiting for the next round');
  });
});
```

`web/src/replay/useReplaySource.test.ts`, append:

```ts
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
    expect(result.current.behindSinceMs).toBe(SINCE);
    expect(result.current.error).toBeNull();
    expect(result.current.header).toBeNull();
    expect(urls.some((u) => u.startsWith('/api/replays/match/'))).toBe(false);
    const before = urls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(urls.length).toBeGreaterThan(before);
  });
});
```

`web/src/replay/Viewer.test.tsx`: below the `NAMES` constant add `let sourceOverride: Record<string, unknown> = {};`, change the mocked hook to

```ts
    useReplaySource: () => ({
      header: HEADER, frames: frames(), closed: true, tooNew: false, error: null, phase: null, behindSinceMs: null,
      ...sourceOverride,
    }),
```

add `sourceOverride = {};` to `afterEach`, and append:

```ts
describe('Viewer live with nothing to draw yet', () => {
  it('says the live view is catching up instead of loading for ever', () => {
    sourceOverride = { header: null, frames: [], closed: false, behindSinceMs: Date.now() - 5_000 };
    render(<Viewer spec={{ kind: 'live-match', matchId: 1 }} live names={NAMES} />);
    expect(screen.getByText('Live view is catching up')).toBeTruthy();
  });

  it('still says loading for a saved replay with no header yet', () => {
    sourceOverride = { header: null, frames: [] };
    render(<Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES} />);
    expect(screen.getByText('Loading replay...')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run web/src/replay/ReplayHud.test.tsx web/src/replay/useReplaySource.test.ts web/src/replay/Viewer.test.tsx`
Expected: FAIL (new texts absent, `behindSinceMs` undefined, "Loading replay..." shown).

- [ ] **Step 3: Implement**

`web/src/replay/ReplayHud.tsx`: above `liveStatusText` add

```ts
/** How long the page says the live view is catching up before it says the
 *  view is not available. Longer than the ten-second delay plus a push that
 *  fell a few seconds behind, shorter than anyone waits before giving up. */
export const CATCH_UP_MS = 30_000;
```

give `liveStatusText` the parameter `behindSinceMs: number | null = null` after `names`, extend its doc comment with the rule order above, and insert after the `loading` line:

```ts
  // The round is being played but the bytes on screen are from an earlier
  // one, or none have arrived. Never "Round over" while the server says the
  // round is live. A live phase over a finished file is the same case seen
  // from the file's side, timed from when the phase began.
  const behind = behindSinceMs ?? (phase?.state === 'live' && closed ? phase.sinceMs : null);
  if (behind !== null) {
    return nowMs - behind < CATCH_UP_MS
      ? 'Live view is catching up'
      : "Live view isn't available for this server right now";
  }
```

`ReplayHud` and `TheaterStatus`: add the prop `behindSinceMs?: number | null` (default `null` in the destructuring) and pass it as the eighth argument in both `liveStatusText` calls in each component.

`web/src/replay/source.ts`: add

```ts
/** The round the server says is being played, from the live answer. */
export interface LiveRound { ordinal: number; half: number; sinceMs: number }
```

In `useReplaySource`: add `behindSinceMs: number | null;` to the return type with the comment "When the round being played is not the one being read (or has no file yet), since when it has been played. Null otherwise, and always null for a saved round or a standalone session."; add `const [behindSinceMs, setBehindSinceMs] = useState<number | null>(null);` beside `phase`; add `setBehindSinceMs(null);` beside `setPhase(null);` in the effect's reset; replace the `live.kind === 'live-match'` branch with:

```ts
          if (live.kind === 'live-match') {
            const body = (await res.json()) as {
              ordinal: number | null; half: number | null; closed: boolean;
              phase?: LivePhase | null; current?: LiveRound | null;
            };
            if (cancelled) return;
            setPhase(body.phase ?? null);
            const cur = body.current ?? null;
            if (body.ordinal === null || body.half === null) {
              // The round being played has no bytes on the site yet: that
              // server's push is off, failing or not started. Nothing to
              // fetch; say since when, and ask again next second.
              setBehindSinceMs(cur?.sinceMs ?? null);
              setError(null);
              timer = setTimeout(tick, POLL_MS);
              return;
            }
            // Reading an older round than the one being played. The page
            // says it is catching up instead of "Round over".
            setBehindSinceMs(
              cur && (cur.ordinal !== body.ordinal || cur.half !== body.half) ? cur.sinceMs : null,
            );
            next = { kind: 'match', matchId: live.matchId, ordinal: body.ordinal, half: body.half };
          } else {
```

and add `behindSinceMs` to the returned object.

`web/src/replay/Viewer.tsx`: destructure `behindSinceMs = null` from `useReplaySource(spec)`; pass `behindSinceMs={behindSinceMs}` to `<ReplayHud>` and `<TheaterStatus>`; replace the no-header early return (288) with:

```tsx
  if (!header) {
    // A live round with no bytes yet says why, rather than "Loading" for ever.
    const waiting = live && behindSinceMs !== null
      ? liveStatusText(live, false, 0, 0, phase, Date.now(), names, behindSinceMs)
      : null;
    return <div class="replay replay--empty">{waiting ?? 'Loading replay...'}</div>;
  }
```

importing `liveStatusText` from `./ReplayHud` (add it to the existing import from that module, or add one).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run web/src/replay`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck.**

- [ ] **Step 6: Commit**

```bash
git add web/src/replay
git commit -m "Say the live view is catching up, then not available, instead of Round over during a live round"
```

---

### Task 7: The plugin pushes the round it records

**Files:**
- Create (vendored, unmodified): `plugin/include/ripext.inc`, `plugin/include/ripext/http.inc`, `plugin/include/ripext/json.inc`
- Create: `plugin/pug-livepush.inc`
- Modify: `plugin/pug-match.sp` (version at 18; include after 354; `OnPluginStart` after the replay cvars ~452; `OnLibraryAdded`/`OnLibraryRemoved` 546-554; `RplOpen` after the header write 1154-1159; `RplClose` index loop 1250-1268 and before `delete g_hReplay` ~1284; `Timer_RplFrame` after `g_iReplayBytes += p;` 1576; `Cmd_Status` ~2407)
- Modify: `plugin/pug-leave.inc:34-38` (`AskPluginLoad2`)
- Modify: `plugin/build.sh`

**Interfaces:**
- Consumes: the endpoint's contract from Tasks 1 and 2: body `{ token, ordinal, half, offset, closed, data, final? }`; answers 200 `{ length }`, 409 `{ length }`, 4xx `{ error }`.
- Produces (SourcePawn, used only inside the plugin): `LivePushInit()`, `LivePushMarkOptional()`, `LivePushLibrary(const char[] name, bool present)`, `LivePushOpen(const char[] token, int ordinal, int half)`, `LivePushAppend(const int[] bytes, int n)`, `LivePushClose(bool patched, int indexOffset, int indexCount, int frames, int fileBytes)`, `LivePushStatus()`; cvars `sm_pug_live_push` (default 0) and `sm_pug_live_push_url` (default `https://riversidepug.com/api/replays/push`).

REST in Pawn API used, all from the 1.3.2 includes (`http.inc`, `json.inc`) and checked against the extension's own sources at tag 1.3.2: `new HTTPRequest(url)`, `.ConnectTimeout`, `.Timeout`, `.Post(JSON data, HTTPRequestCallback callback, any value)` with the three-argument callback `(HTTPResponse response, any value, const char[] error)`; `HTTPResponse.Status` and `.Data`; `new JSONObject()`, `.SetString`, `.SetInt`, `.SetBool`, `.Set`, `.HasKey`, `.GetInt`. Handle ownership, verified in the extension source: `Post` serialises the body before it returns (`HTTPRequestContext`'s constructor calls `json_dumps`, `httprequestcontext.cpp:92`) and frees the request handle itself, so the plugin deletes its `JSONObject` right after `Post`; `JSONObject.Set` takes its own reference (`json_object_set`, `json_natives.cpp:265`), so the nested object is deleted after `Set`; the response and its `Data` are freed by the extension after the callback returns (`httprequestcontext.cpp:202-203`), so the callback never deletes them. The extension registers the library name `ripext` (`extension.cpp:219`).

The draft of `pug-livepush.inc` below was compiled on 2026-09-23 with this repo's spcomp (SourcePawn 1.12.0.7239, the Rotoblin tree's `spcomp.exe` under wine) against a stub harness: 0 errors, 404,972 bytes of data (the 320 KiB ring and the 64 KiB base64 buffer).

- [ ] **Step 1: Record the baseline build**

Run: `cd plugin && ./build.sh 2>&1 | tail -5`
Expected: `built: .../plugin/pug-match.smx`. Note the warning count; the final build must not add warnings.

- [ ] **Step 2: Vendor the REST in Pawn includes and check them**

```bash
cd plugin
mkdir -p include/ripext
B=https://raw.githubusercontent.com/ErikMinekus/sm-ripext/1.3.2/pawn/scripting/include
curl -fsSL "$B/ripext.inc" -o include/ripext.inc
curl -fsSL "$B/ripext/http.inc" -o include/ripext/http.inc
curl -fsSL "$B/ripext/json.inc" -o include/ripext/json.inc
sha256sum include/ripext.inc include/ripext/http.inc include/ripext/json.inc
```

Expected, exactly:

```
c56bf37fa29406fdcbcb1c4853372414fa1bd03154438dd1398c7d30a7fca895  include/ripext.inc
b8781dff9aec7aa94b3d55300e976f38ee1171ed9079c462715cfc69f0147a05  include/ripext/http.inc
8f0ba021a115a965aa03b0676b99b0417dda6a9a3355029b7576ef8a6fcb0559  include/ripext/json.inc
```

The installed extension is this version: `strings /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/extensions/rip.ext.so | grep sm-ripext/` prints `sm-ripext/1.3.2`, and its md5 (`d95bc0d0...`) equals Dallas's copy in `deploy/state/dallas`.

- [ ] **Step 3: Create `plugin/pug-livepush.inc`** with exactly this content:

```sourcepawn
// pug-livepush.inc: send the round being recorded to the site, once a second,
// so the live viewer works on servers the site does not share a disk with.
//
// Included by pug-match.sp below the replay globals, because it reads
// g_State. Everything here is optional. With sm_pug_live_push 0 (the default)
// or with REST in Pawn absent, LivePushOpen leaves the round inactive, every
// other entry point returns at its first line, and the recorder writes exactly
// the file it wrote before this existed.
//
// Shape of the stream: the site keeps a copy of the file that is always an
// exact prefix of it. The plugin keeps every byte the site has not confirmed
// in a ring, posts them from the confirmed offset, and moves the confirmed
// offset to whatever length the site answers with. One request at a time.

// Optional, the same way geoip is at the top of pug-match.sp: with
// REQUIRE_EXTENSIONS off the plugin still loads where the extension is
// missing. core.inc already defines AUTOLOAD_EXTENSIONS, which is what makes
// SourceMod try to load rip.ext when this plugin loads; nothing else on these
// boxes asks for it.
#undef REQUIRE_EXTENSIONS
#include <ripext>
#define REQUIRE_EXTENSIONS

/** Unconfirmed bytes kept: about 60 seconds at the busiest rate a round writes
 *  (a full entity block every frame is about 17 KB/s; a typical round is 5). */
#define LP_CAP          327680
/** Raw bytes per request. Base64 makes this exactly 65536 characters, which is
 *  what the site's 64 KiB data cap and 128 KiB body cap are sized around. */
#define LP_BATCH_MAX    49152
#define LP_B64_LEN      65537
/** A request with no callback after this long is written off. ripext calls
 *  back on every outcome, including a timeout, so this is a backstop. */
#define LP_STUCK_SECS   15

ConVar g_cvLivePush;
ConVar g_cvLivePushUrl;
bool g_bLpRipExt;

char g_sLpRing[LP_CAP];          // file byte o is at g_sLpRing[o % LP_CAP]
char g_sLpB64[LP_B64_LEN];
char g_sLpAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int g_iLpRound;                  // bumped by every LivePushOpen: a reply names its round by this
bool g_bLpActive;                // this round is being pushed
int g_iLpBase;                   // first file byte the site has not confirmed
int g_iLpEnd;                    // one past the last file byte appended
bool g_bLpClosed;                // RplClose has run for this round
bool g_bLpHasFinal;              // ... and patched the header, with these values
int g_iLpFinal[3];               // indexOffset, indexCount, frameCount
char g_sLpToken[65];
int g_iLpOrdinal;
int g_iLpHalf;

bool g_bLpInFlight;
int g_iLpSeq;                    // bumped for every request; the callback's value
int g_iLpInFlightSeq;
int g_iLpInFlightRound;
bool g_bLpInFlightClosed;
int g_iLpInFlightAt;

void LivePushInit()
{
	g_cvLivePush = CreateConVar("sm_pug_live_push", "0",
		"1 = send the round being recorded to the site once a second, for the live viewer. Needs the REST in Pawn extension; without it this does nothing. Takes effect at the next round.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvLivePushUrl = CreateConVar("sm_pug_live_push_url", "https://riversidepug.com/api/replays/push",
		"Where live replay bytes are posted. The box that hosts the site posts to itself over 127.0.0.1 instead.",
		FCVAR_NONE);
	g_bLpRipExt = LibraryExists("ripext");
	// Not TIMER_FLAG_NO_MAPCHANGE: this has to outlive every map change, and
	// the final batch of a round is often sent after its map has ended.
	CreateTimer(1.0, Timer_LivePush, _, TIMER_REPEAT);
}

/** Called from AskPluginLoad2. The extension is optional, and a plugin that
 *  references an unbound native without this refuses to load. Every native
 *  this file calls is listed; adding a call means adding its name here. */
void LivePushMarkOptional()
{
	MarkNativeAsOptional("HTTPRequest.HTTPRequest");
	MarkNativeAsOptional("HTTPRequest.Post");
	MarkNativeAsOptional("HTTPRequest.ConnectTimeout.set");
	MarkNativeAsOptional("HTTPRequest.Timeout.set");
	MarkNativeAsOptional("HTTPResponse.Status.get");
	MarkNativeAsOptional("HTTPResponse.Data.get");
	MarkNativeAsOptional("JSONObject.JSONObject");
	MarkNativeAsOptional("JSONObject.SetString");
	MarkNativeAsOptional("JSONObject.SetInt");
	MarkNativeAsOptional("JSONObject.SetBool");
	MarkNativeAsOptional("JSONObject.Set");
	MarkNativeAsOptional("JSONObject.HasKey");
	MarkNativeAsOptional("JSONObject.GetInt");
}

void LivePushLibrary(const char[] name, bool present)
{
	if (StrEqual(name, "ripext")) g_bLpRipExt = present;
}

static bool LpRipReady()
{
	return g_bLpRipExt
		&& GetFeatureStatus(FeatureType_Native, "HTTPRequest.Post") == FeatureStatus_Available;
}

/** A round's file was opened and its header written. The header's bytes
 *  follow through LivePushAppend like every other write. */
void LivePushOpen(const char[] token, int ordinal, int half)
{
	g_iLpRound++;
	g_bLpActive = g_cvLivePush.BoolValue && LpRipReady() && g_State == MS_Live && token[0] != '\0';
	g_iLpBase = 0;
	g_iLpEnd = 0;
	g_bLpClosed = false;
	g_bLpHasFinal = false;
	strcopy(g_sLpToken, sizeof(g_sLpToken), token);
	g_iLpOrdinal = ordinal;
	g_iLpHalf = half;
}

/** Bytes the recorder just wrote to the file, in file order: one byte per
 *  cell, the recorder's own buffer layout. */
void LivePushAppend(const int[] bytes, int n)
{
	if (!g_bLpActive || n <= 0) return;
	if (g_iLpEnd + n - g_iLpBase > LP_CAP)
	{
		// The site has confirmed nothing for about a minute. Give up on this
		// round rather than grow; the copy job brings the whole file anyway.
		g_bLpActive = false;
		LogMessage("pug: live push is %d bytes behind; stopped for this round", g_iLpEnd + n - g_iLpBase);
		return;
	}
	int pos = g_iLpEnd % LP_CAP;
	for (int i = 0; i < n; i++)
	{
		g_sLpRing[pos] = bytes[i] & 0xFF;
		if (++pos == LP_CAP) pos = 0;
	}
	g_iLpEnd += n;
}

/** The recorder closed the file. `patched` is whether the header now carries
 *  the index and frame count, which the site then writes into its copy so the
 *  two stay byte for byte the same. `fileBytes` is the file's full length,
 *  checked against what went through the ring. */
void LivePushClose(bool patched, int indexOffset, int indexCount, int frames, int fileBytes)
{
	if (!g_bLpActive) return;
	if (patched && fileBytes != g_iLpEnd)
	{
		LogError("pug: live push saw %d bytes of a %d byte file; stopped for this round", g_iLpEnd, fileBytes);
		g_bLpActive = false;
		return;
	}
	g_bLpClosed = true;
	g_bLpHasFinal = patched;
	g_iLpFinal[0] = indexOffset;
	g_iLpFinal[1] = indexCount;
	g_iLpFinal[2] = frames;
}

/** One line for sm_pug_status. */
void LivePushStatus()
{
	DumpLine("STATUS livepush on=%d ripext=%d active=%d base=%d end=%d closed=%d inflight=%d",
		g_cvLivePush.BoolValue ? 1 : 0, LpRipReady() ? 1 : 0, g_bLpActive ? 1 : 0,
		g_iLpBase, g_iLpEnd, g_bLpClosed ? 1 : 0, g_bLpInFlight ? 1 : 0);
}

public Action Timer_LivePush(Handle timer)
{
	if (g_bLpInFlight)
	{
		if (GetTime() - g_iLpInFlightAt < LP_STUCK_SECS) return Plugin_Continue;
		// Written off. Clearing the slot's sequence number is what makes a
		// late callback for it be ignored.
		g_bLpInFlight = false;
		g_iLpInFlightSeq = 0;
	}
	if (!g_bLpActive || !g_cvLivePush.BoolValue || !LpRipReady()) return Plugin_Continue;
	if (g_iLpEnd == g_iLpBase && !g_bLpClosed) return Plugin_Continue;
	LpSend();
	return Plugin_Continue;
}

static void LpSend()
{
	char url[256];
	g_cvLivePushUrl.GetString(url, sizeof(url));
	if (url[0] == '\0') return;

	int count = g_iLpEnd - g_iLpBase;
	if (count > LP_BATCH_MAX) count = LP_BATCH_MAX;
	bool closing = g_bLpClosed && g_iLpBase + count == g_iLpEnd;
	LpBase64(g_iLpBase, count, g_sLpB64, sizeof(g_sLpB64));

	JSONObject body = new JSONObject();
	body.SetString("token", g_sLpToken);
	body.SetInt("ordinal", g_iLpOrdinal);
	body.SetInt("half", g_iLpHalf);
	body.SetInt("offset", g_iLpBase);
	body.SetBool("closed", closing);
	body.SetString("data", g_sLpB64);
	if (closing && g_bLpHasFinal)
	{
		JSONObject fin = new JSONObject();
		fin.SetInt("indexOffset", g_iLpFinal[0]);
		fin.SetInt("indexCount", g_iLpFinal[1]);
		fin.SetInt("frameCount", g_iLpFinal[2]);
		body.Set("final", fin);   // json_object_set takes its own reference
		delete fin;
	}

	HTTPRequest req = new HTTPRequest(url);
	req.ConnectTimeout = 3;
	req.Timeout = 5;
	g_iLpSeq++;
	g_bLpInFlight = true;
	g_iLpInFlightSeq = g_iLpSeq;
	g_iLpInFlightRound = g_iLpRound;
	g_bLpInFlightClosed = closing;
	g_iLpInFlightAt = GetTime();
	// Post serialises the body before it returns (HTTPRequestContext's
	// constructor calls json_dumps), so the handle is ours to free now.
	req.Post(body, LpOnReply, g_iLpSeq);
	delete body;
}

public void LpOnReply(HTTPResponse response, any seq, const char[] error)
{
	// Only the request that holds the slot may free it: one written off by
	// the timer must not clear the flag of the request sent after it.
	if (seq != g_iLpInFlightSeq) return;
	g_bLpInFlight = false;
	// A reply for a round that is over says nothing about this one.
	if (g_iLpInFlightRound != g_iLpRound || !g_bLpActive) return;

	int code = view_as<int>(response.Status);
	if (code == 200)
	{
		int length = LpReplyLength(response);
		if (length > g_iLpBase && length <= g_iLpEnd) g_iLpBase = length;
		// The site has every byte of a closed round: nothing left to do.
		if (g_bLpInFlightClosed && length == g_iLpEnd) g_bLpActive = false;
		return;
	}
	if (code == 409)
	{
		// The site holds a different length than we sent from. Resume from
		// it when it is a length we can still send from.
		int length = LpReplyLength(response);
		if (length >= g_iLpBase && length <= g_iLpEnd) g_iLpBase = length;
		else
		{
			g_bLpActive = false;
			PugDebug("live push: site holds %d bytes, outside %d..%d; stopped for this round", length, g_iLpBase, g_iLpEnd);
		}
		return;
	}
	if (code >= 400 && code < 500)
	{
		// Not a live match, a bad batch, or too large: retrying cannot help.
		g_bLpActive = false;
		PugDebug("live push: refused with %d; stopped for this round", code);
		return;
	}
	// 0 (no connection, timeout) or a 5xx: the next second resends from the
	// confirmed offset. Nothing is queued.
	PugDebug("live push: no answer (%d %s); retrying", code, error);
}

static int LpReplyLength(HTTPResponse response)
{
	// Owned by the response and freed by ripext after this callback returns.
	JSONObject data = view_as<JSONObject>(response.Data);
	if (data == null || !data.HasKey("length")) return -1;
	return data.GetInt("length");
}

/** Base64 of `count` ring bytes starting at file byte `from`. */
static void LpBase64(int from, int count, char[] out, int maxlen)
{
	int o = 0;
	int i = 0;
	while (i + 3 <= count && o + 4 < maxlen)
	{
		int v = (LpByte(from + i) << 16) | (LpByte(from + i + 1) << 8) | LpByte(from + i + 2);
		out[o++] = g_sLpAlphabet[(v >> 18) & 63];
		out[o++] = g_sLpAlphabet[(v >> 12) & 63];
		out[o++] = g_sLpAlphabet[(v >> 6) & 63];
		out[o++] = g_sLpAlphabet[v & 63];
		i += 3;
	}
	int rest = count - i;
	if (rest > 0 && o + 4 < maxlen)
	{
		int v = LpByte(from + i) << 16;
		if (rest == 2) v |= LpByte(from + i + 1) << 8;
		out[o++] = g_sLpAlphabet[(v >> 18) & 63];
		out[o++] = g_sLpAlphabet[(v >> 12) & 63];
		if (rest == 2) out[o++] = g_sLpAlphabet[(v >> 6) & 63];
		else out[o++] = '=';
		out[o++] = '=';
	}
	out[o] = '\0';
}

static int LpByte(int fileOffset)
{
	return g_sLpRing[fileOffset % LP_CAP] & 0xFF;
}
```

- [ ] **Step 4: Wire it into `plugin/pug-match.sp`**

1. Line 18: `#define PLUGIN_VERSION "0.3.6"`.
2. Directly after `int g_iRplBuf[RPL_FRAME_MAX];` (354), add:

```sourcepawn

// Live push of the round being recorded. Below the replay globals because it
// reads g_State; see the include for why everything in it is optional.
#include "pug-livepush.inc"
```

3. In `OnPluginStart`, directly after the `g_cvReplayMaxMb = CreateConVar(...)` statement, add `LivePushInit();`.
4. `OnLibraryAdded` and `OnLibraryRemoved` become:

```sourcepawn
public void OnLibraryAdded(const char[] name)
{
	if (StrEqual(name, "readyup")) g_bReadyUpAvailable = true;
	LivePushLibrary(name, true);
}

public void OnLibraryRemoved(const char[] name)
{
	if (StrEqual(name, "readyup")) g_bReadyUpAvailable = false;
	LivePushLibrary(name, false);
}
```

5. In `RplOpen`, directly after the header write's failure block (the `}` that closes `if (!WriteFile(g_hReplay, g_iRplBuf, RPL_HEADER_BYTES, 1)) { ... }`), add:

```sourcepawn
	// Only after the header is safely on disk: a failed write goes to RplFail
	// above and this round is never pushed at all.
	LivePushOpen(g_sToken, g_iRplMapSeq, g_iHalf);
	LivePushAppend(g_iRplBuf, RPL_HEADER_BYTES);
```

6. In `Timer_RplFrame`, directly after `g_iReplayBytes += p;`, add `LivePushAppend(g_iRplBuf, p);` (the buffer still holds exactly the frame just written).
7. In `RplClose`, the index loop and its tail become:

```sourcepawn
		for (int i = 0; i < count; i++)
		{
			// The buffer holds RPL_FRAME_MAX bytes, far more than any index
			// this loop writes for a round of sane length, but flush in
			// chunks anyway so a very long round cannot overrun it.
			if (p + RPL_INDEX_RECORD > RPL_FRAME_MAX)
			{
				if (!WriteFile(g_hReplay, g_iRplBuf, p, 1)) { ok = false; break; }
				LivePushAppend(g_iRplBuf, p);
				p = 0;
			}
			p = RplU32(p, g_hRplIndexT.Get(i));
			p = RplU32(p, g_hRplIndexOff.Get(i));
		}
		if (ok && p > 0)
		{
			if (!WriteFile(g_hReplay, g_iRplBuf, p, 1)) ok = false;
			else LivePushAppend(g_iRplBuf, p);
		}
```

and directly after `if (!ok) LogError("pug: replay close incomplete; ...");` add:

```sourcepawn
	// The header patches above are not appends, so the push carries their
	// values and the site writes them into its copy. Only when every write
	// succeeded; otherwise the copy stays exactly as unpatched as the file.
	LivePushClose(ok, count > 0 ? indexOffset : 0, count, g_iReplayFrames,
		indexOffset + count * RPL_INDEX_RECORD);
```

8. In `Cmd_Status`, directly after the `DumpLine("STATUS selfStarted=...` statement, add `LivePushStatus();`.

`plugin/pug-leave.inc`, `AskPluginLoad2` becomes:

```sourcepawn
public APLRes AskPluginLoad2(Handle myself, bool late, char[] error, int err_max)
{
	MarkNativeAsOptional("IsInPause");
	// REST in Pawn is optional: see pug-livepush.inc.
	LivePushMarkOptional();
	return APLRes_Success;
}
```

- [ ] **Step 5: Teach `plugin/build.sh` the new files**

After `cp pug-hmac.inc "$SCRIPTING/pug-hmac.inc"` add `cp pug-livepush.inc "$SCRIPTING/pug-livepush.inc"`, add `$SCRIPTING/pug-livepush.inc` to the initial `CLEANUP` list, and after the `GEOIP_INC` block add:

```bash
# REST in Pawn's includes are vendored in plugin/include (1.3.2, the version
# installed on every server). Same borrow-and-clean-up rule as above.
RIPEXT_INC="$SCRIPTING/include/ripext.inc"
RIPEXT_DIR_MADE=0
if [ ! -e "$RIPEXT_INC" ]; then
	[ -d "$SCRIPTING/include/ripext" ] || { mkdir "$SCRIPTING/include/ripext"; RIPEXT_DIR_MADE=1; }
	cp include/ripext.inc "$RIPEXT_INC"
	cp include/ripext/http.inc include/ripext/json.inc "$SCRIPTING/include/ripext/"
	CLEANUP="$CLEANUP $RIPEXT_INC $SCRIPTING/include/ripext/http.inc $SCRIPTING/include/ripext/json.inc"
fi
```

and change the trap line to:

```bash
trap 'rm -f '"$CLEANUP"'; [ '"$RIPEXT_DIR_MADE"' = 1 ] && rmdir "'"$SCRIPTING"'/include/ripext" 2>/dev/null; true' EXIT
```

- [ ] **Step 6: Compile**

Run: `cd plugin && ./build.sh 2>&1 | grep -E "error|warning|Warning|Error|built:"`
Expected: `built: .../plugin/pug-match.smx`, no `error`, and the same warning count as Step 1. Then confirm the build left the Rotoblin tree clean: `ls /home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az/include/ | grep -c ripext` prints `0` (unless a ripext include was already there before, in which case it is untouched), and `git -C /home/volence/l4d/Rotoblin-AZMod status --short SourceCode/scripting-az` shows nothing new.

- [ ] **Step 7: Read the hooks back once**

Run: `grep -n "LivePush" plugin/pug-match.sp plugin/pug-leave.inc`
Expected: exactly 10 lines in `pug-match.sp` (`LivePushInit`, `LivePushLibrary` twice, `LivePushOpen`, `LivePushAppend` four times (header, frame, two in the index loop), `LivePushClose`, `LivePushStatus`; the include line is lower case and does not match) and 1 in `pug-leave.inc`. Every entry point returns at its first line unless `g_bLpActive`, which `LivePushOpen` sets only when `sm_pug_live_push` is 1, REST in Pawn is loaded and the match is `MS_Live`: that is the whole "recording unchanged when off" argument, and the manual test below proves it.

- [ ] **Step 8: Full suite and typecheck** (the site is untouched by this task; run them anyway).

- [ ] **Step 9: Commit** (the `.smx` is gitignored)

```bash
git add plugin/include plugin/pug-livepush.inc plugin/pug-match.sp plugin/pug-leave.inc plugin/build.sh
git commit -m "Push the round being recorded to the site once a second, when sm_pug_live_push is on"
```

---

## After the last task

These are for the controller and the owner. Nothing here is done by an implementer.

### A. Local test server (`/home/volence/l4d1-ds`)

- [ ] Local site from this worktree with its own scratch state: `npm run build`, then `DB_PATH=$S/pug.db PORT=8099 LOG_LISTEN_PORT=27511 REPLAY_DIR=$S/replays REPLAY_LIVE_DIR=$S/replays-live npx tsx src/index.ts` with `$S` a scratch directory and `$S/replays` empty, so only the push can feed the viewer. Insert a live match with a 32-hex token: `sqlite3 $S/pug.db "INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', '<token>')"`.
- [ ] Copy `plugin/pug-match.smx` into `/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/`. If `configs/ripext/ca-bundle.crt` is missing locally, copy `configs/ripext/` from `/home/volence/l4d/deploy/state/dallas/left4dead/addons/sourcemod/configs/`. Start with `/home/volence/l4d1-ds/start-test.sh`.
- [ ] REST in Pawn loads on L4D1: `sm exts list` shows "REST in Pawn" running; `sm plugins list` shows PUG Match 0.3.6; `errors_*.log` has nothing new. This is the spec's first unverified assumption.
- [ ] Push on: over rcon, `sm_pug_live_push_url "http://127.0.0.1:8099/api/replays/push"`, `sm_pug_live_push 1`, `sm_pug_min_orient 1`, `sm_pug_debug 1`, then `sm_pug_match 999 <token> no_mercy` and the roster lines from `plugin/TESTING.md` section 2; go live with bots as that runbook does.
- [ ] While the round runs: `sm_pug_status` shows `STATUS livepush on=1 ripext=1 active=1` with `base` advancing about 5 KB a second; `$S/replays-live/pug_<token>_0_1.rpl` grows; `cmp -n $(stat -c%s <live file>) <live file> <server's own file under left4dead/replays/>` reports no difference.
- [ ] Viewer: `curl -s localhost:8099/api/replays/live/match/<id>` names ordinal 0 half 1, and `curl -sD- -o /dev/null "localhost:8099/api/replays/match/<id>/0/1?since=0"` shows `X-Replay-Next` growing across calls; open the live page at `http://localhost:8099/live` if the match is listed there (it needs the log feed for the roster; the two API calls are the proof when it is not).
- [ ] Round end: `cmp` of the whole live file against the server's finished file reports no difference (the header patch landed), and `sm_pug_status` shows `active=0`.
- [ ] Outage: stop the local site mid-round; the plugin logs retries under `sm_pug_debug 1` and, after about a minute, `live push is ... bytes behind; stopped for this round`; the server's own file is unaffected. Start the site again; the next round pushes.
- [ ] Extension absent: stop the server, rename `extensions/rip.ext.so` to `rip.ext.so.off`, start it, and confirm PUG Match 0.3.6 loads, `STATUS livepush ... ripext=0 active=0`, and a round records a normal file in `left4dead/replays/`. Restore the file.
- [ ] Tick timing: two bot rounds of similar length, one with `sm_pug_live_push 0` and one with 1. Compare `sm_tick` and the `frames-<date>.csv` rows under `addons/sourcemod/data/tickstats/`: p99 with pushing on must stay within 0.25 ms of off (production baseline p99 11.25 ms) and `tick_anomalies` must stay 0. Record both numbers for the owner.

### B. Rollout (spec, "Rollout"; every step undone by `sm_pug_live_push 0`, no restart)

- [ ] 1. Site deploy with `deploy-web.sh` under the owner's standing rule (no players in game). The endpoint is dormant. Check it answers: `curl -s -X POST https://riversidepug.com/api/replays/push -H 'content-type: application/json' -d '{}'` gives `{"error":"expected a JSON object"}` or `bad token`, never 404 HTML. On Dallas, confirm the site's port with `ss -ltnp | grep node` (8080 per `src/index.ts`'s default and the 2026-09-19 audit).
- [ ] 2. Plugin staged on each empty server with pushing off (`plugin/stage.sh` for Dallas; the other boxes by their own procedure). Note that this is the first time `rip.ext.so` is loaded on the production servers: the plugin autoloads it. Check `sm exts list` on each. Re-assert `auto_track` and `roster_at_live` afterwards (see the audit-hardening ship order).
- [ ] 3. Dallas on: add `sm_pug_live_push_url "http://127.0.0.1:8080/api/replays/push"` and `sm_pug_live_push 1` to Dallas's `cfg/local.cfg`, and set both over rcon. Watch one real match: the live page, `sm_tick` p99, the site's journal, `data/replays-live`.
- [ ] 4. Riverside #3 and #4 on: `sm_pug_live_push 1` in each `local.cfg` and over rcon (the default URL is already the public site).
- [ ] 5. Chicago last. It has no shell, so the outgoing HTTPS check is the push itself: turn it on for one real match and watch `sm_pug_status` (`base` advancing, `inflight` not stuck) or the site's live directory. If nothing arrives, set it back to 0; Chicago stays on the delayed copy and the page says "Live view isn't available for this server right now" after 30 seconds, which is the honest answer.

## Decisions and deviations from the spec

1. **`ordinal`, not `map`, in the request body.** Files are named `pug_<token>_<ordinal>_<half>.rpl` (`plugin/pug-match.sp:1032`), so the ordinal is what names the live file; the map name is already in the header.
2. **At most 48 KiB per request** instead of "every unconfirmed byte". Base64 and JSON of up to 300 KB on the game thread every second during a backlog is exactly the tick cost the owner ruled out; 48 KiB drains a full 60 s backlog in about seven requests.
3. **The closing batch carries `final` header values.** `RplClose` patches bytes 80-87 and 152-155 of the real file after writing the index (`pug-match.sp:1270-1281`), which no append can express. Without the patch the copy would never equal the final file and would read as unclosed. A closing batch without `final` (the plugin's close was incomplete) leaves the header unpatched, exactly like the real file, and the copy then reads as finished through the existing 60 s idle rule (`CLOSED_AFTER_IDLE_MS`).
4. **A round restarted under the same name starts the copy again.** A batch at offset 0 whose header's `startedUnix` differs from the live copy's truncates it; otherwise the offset rule would refuse that round for good.
5. **A partial overlap is refused with 409**, as the spec's "any other offset" says; the plugin resends from the returned length a second later.
6. **The live directory defaults to `replays-live` beside the database** (`data/replays-live`), not beside the replay store. On Dallas the replay directory lives in the game server tree, which deploy rsyncs and whose group-write bits deploy has stripped before; the pull jobs write the replay directory too. The site's own data directory has neither problem. `REPLAY_LIVE_DIR` overrides it.
7. **Only tracked matches push** (`g_State == MS_Live`). Standalone `!mix` rounds and post-finale recording never push; the site would refuse them anyway (no live match).
8. **The plugin gives up on a round** on any 4xx other than 409, on a 409 whose length it can no longer send from, and on passing the 320 KiB backlog cap; it retries every second on no answer or a 5xx. Connect timeout 3 s, total 5 s, a request with no callback written off after 15 s.
9. **Default URL is the public site**, so only Dallas sets `sm_pug_live_push_url`; a new server needs `sm_pug_live_push 1` and nothing else.
10. **"The round being played"** is the newest `match_rounds` row, started and not ended, only while the phase is live or paused. A live phase over a closed file also counts as behind, timed from the phase.
11. **Dallas's first ten seconds of each round now read "Live view is catching up"** instead of "Round over, catching up", because the previous round's last ten seconds are playing out while the new round is live. That is the spec's "never Round over while the round is live" applied literally.
12. **The live route answers 200 with `ordinal: null`** when a round is in progress but has no file, instead of 404, so the viewer can speak; with no file and no round in progress it still 404s.
13. **Hardening beyond the spec:** the first batch must carry a whole header whose token and half match the batch; ordinal at most 999; a 64 MiB ceiling per live file; a live file whose index would lie outside it is not patched.
14. **Cleanup runs every ten minutes** (the spec gives the rule, not the cadence).
15. **`sm_pug_status` gains a `STATUS livepush` line** and the plugin version becomes 0.3.6.
