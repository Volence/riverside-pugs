import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, utimesSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePush, applyPush, liveFileName, pruneLiveFiles, pruneLiveFilesSafely, PUSH_MAX_DATA_BYTES, type PushBatch,
} from '../src/replayPush.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, PLAYER_SLOTS,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';
import { openDb, type DB } from '../src/db.js';

const TOKEN = 'c'.repeat(32);
const STARTED = 1_785_956_274;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: STARTED, indexOffset: 0, indexCount: 0, frameCount: 0,
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

/** A batch naming the default round (`STARTED`) unless overridden. When a
 *  test builds `roundBytes` with a different `startedUnix`, it must pass the
 *  same value here as `started`: the two are independent fields on purpose,
 *  the same way the plugin sends them independently. */
function batch(offset: number, data: Buffer, over: Partial<PushBatch> = {}): PushBatch {
  return { token: TOKEN, ordinal: 0, half: 1, offset, started: STARTED, closed: false, data, final: null, ...over };
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: TOKEN, ordinal: 0, half: 1, offset: 0, started: STARTED, closed: false,
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
    expect(r.batch).toMatchObject({ token: TOKEN, ordinal: 0, half: 1, offset: 0, started: STARTED, closed: false, final: null });
    expect(r.batch.data.equals(roundBytes(1))).toBe(true);
  });

  it('refuses anything malformed with 400', () => {
    for (const bad of [
      null, [], 'x',
      body({ token: 'C'.repeat(32) }), body({ token: 'c'.repeat(31) }),
      body({ ordinal: -1 }), body({ ordinal: 1.5 }), body({ ordinal: 1000 }),
      body({ half: 3 }), body({ half: '1' }),
      body({ offset: -1 }), body({ offset: 0.5 }),
      body({ started: -1 }), body({ started: 1.5 }), body({ started: '1000' }), body({ started: undefined }),
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

  it('refuses an overlap whose bytes differ from what is on disk, writing nothing', () => {
    applyPush(liveDir, batch(0, whole.subarray(0, 1000)));
    const different = Buffer.alloc(500, 0xff);
    expect(applyPush(liveDir, batch(200, different))).toEqual({ status: 409, length: 1000 });
    expect(statSync(livePath()).size).toBe(1000);
    expect(readFileSync(livePath()).equals(whole.subarray(0, 1000))).toBe(true);
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
    expect(applyPush(liveDir, batch(0, roundBytes(1, { ordinal: 1 })))).toMatchObject({ status: 400 });
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
    applyPush(liveDir, batch(0, roundBytes(5, { startedUnix: 1000 }), { started: 1000 }));
    const again = roundBytes(2, { startedUnix: 2000 });
    expect(applyPush(liveDir, batch(0, again, { started: 2000 }))).toEqual({ status: 200, length: again.length });
    expect(readFileSync(livePath()).equals(again)).toBe(true);
  });

  it('refuses a stale offset-0 batch from an older round, leaving a newer copy untouched', () => {
    applyPush(liveDir, batch(0, roundBytes(2, { startedUnix: 1000 }), { started: 1000 }));
    const newRound = roundBytes(2, { startedUnix: 2000 });
    applyPush(liveDir, batch(0, newRound, { started: 2000 }));
    // A late offset-0 batch from the OLD round arrives after the NEW round
    // already replaced the copy: refused, not silently accepted as identical
    // or, worse, treated as a fresh restart backwards in time.
    const lateOld = roundBytes(3, { startedUnix: 1000 });
    expect(applyPush(liveDir, batch(0, lateOld, { started: 1000 })))
      .toMatchObject({ status: 409, error: 'stale round' });
    expect(readFileSync(livePath()).equals(newRound)).toBe(true);
  });

  it('refuses a late non-zero-offset batch from an old round even when its offset equals the new copy\'s length', () => {
    applyPush(liveDir, batch(0, roundBytes(5, { startedUnix: 1000 }), { started: 1000 }));
    const newRound = roundBytes(2, { startedUnix: 2000 });
    applyPush(liveDir, batch(0, newRound, { started: 2000 }));
    // A stray in-flight batch from the OLD round, claiming an offset that
    // happens to equal the NEW round's current length. Offset alone cannot
    // tell the two rounds apart, so this must still be refused.
    const strayOldBytes = Buffer.from(encodeFrame(emptyFrame(999)));
    expect(applyPush(liveDir, batch(newRound.length, strayOldBytes, { started: 1000 })))
      .toMatchObject({ status: 409 });
    expect(readFileSync(livePath()).equals(newRound)).toBe(true);
  });

  it('refuses a same-second restart whose bytes differ, even though started matches', () => {
    const first = roundBytes(5, { startedUnix: 5000 });
    applyPush(liveDir, batch(0, first, { started: 5000 }));
    // A genuinely different round starting in the same unix second: started
    // is unchanged, but the content is not the round already on disk.
    const second = roundBytes(5, { startedUnix: 5000, map: 'l4d_vs_hospital01_apartment' });
    expect(applyPush(liveDir, batch(0, second, { started: 5000 })))
      .toMatchObject({ status: 409 });
    expect(readFileSync(livePath()).equals(first)).toBe(true);
  });

  it('refuses a first batch whose declared started does not match its own header, with 400', () => {
    // started and the header's startedUnix are independent fields the plugin
    // sets from the same value; a mismatch is a plugin bug, not a race, so it
    // must fail loudly rather than loop as 'stale round'.
    const mismatched = roundBytes(1, { startedUnix: 1000 });
    expect(applyPush(liveDir, batch(0, mismatched, { started: 999 })))
      .toMatchObject({ status: 400, error: 'started does not match header' });
    expect(existsSync(livePath())).toBe(false);
  });

  it('refuses to create a brand new live file when the store is already over an injected cap', () => {
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'stale.rpl'), Buffer.alloc(2000));
    expect(applyPush(liveDir, batch(0, whole), 1000)).toEqual({ status: 507, error: 'live store is full' });
    expect(existsSync(livePath())).toBe(false);
  });

  it('refuses a newer round replacing a stale file when it would put the store over an injected cap, leaving the stale file untouched', () => {
    mkdirSync(liveDir, { recursive: true });
    applyPush(liveDir, batch(0, roundBytes(5, { startedUnix: 1000 }), { started: 1000 }), 1_000_000_000);
    writeFileSync(join(liveDir, 'stale.rpl'), Buffer.alloc(2000));
    const newRound = roundBytes(2, { startedUnix: 2000 });
    expect(applyPush(liveDir, batch(0, newRound, { started: 2000 }), 1000))
      .toEqual({ status: 507, error: 'live store is full' });
    // Nothing was truncated: the old round's own copy is exactly as it was.
    expect(readFileSync(livePath()).equals(roundBytes(5, { startedUnix: 1000 }))).toBe(true);
  });

  it('does not cap an ordinary append to a file that already exists, even over the injected cap', () => {
    mkdirSync(liveDir, { recursive: true });
    applyPush(liveDir, batch(0, whole.subarray(0, 1000)), 1_000_000_000);
    writeFileSync(join(liveDir, 'stale.rpl'), Buffer.alloc(2000));
    expect(applyPush(liveDir, batch(1000, whole.subarray(1000)), 1000)).toEqual({ status: 200, length: 3520 });
    expect(readFileSync(livePath()).equals(whole)).toBe(true);
  });
});

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

  it('keeps a finished match\'s file when the same-named final file is a different, older round, even though it is longer', () => {
    // Same token, ordinal and half: an aborted round and its restart reuse
    // the filename. The final file here belongs to the OLD round (an earlier
    // startedUnix) and must not be read as having superseded the NEW round's
    // live copy just because it happens to be at least as long.
    seed('completed', TOKEN);
    const liveBytes = Buffer.concat([
      Buffer.from(encodeHeader(header({ startedUnix: 2000 }))),
      Buffer.alloc(40),
    ]);
    const olderFinalBytes = Buffer.concat([
      Buffer.from(encodeHeader(header({ startedUnix: 1000 }))),
      Buffer.alloc(400),
    ]);
    writeFileSync(join(live, name(TOKEN)), liveBytes);
    writeFileSync(join(replays, name(TOKEN)), olderFinalBytes);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(0);
    expect(existsSync(join(live, name(TOKEN)))).toBe(true);
  });

  it('deletes a finished match\'s file when the same-named final file is the same round and at least as long', () => {
    seed('completed', TOKEN);
    const liveBytes = Buffer.concat([
      Buffer.from(encodeHeader(header({ startedUnix: 2000 }))),
      Buffer.alloc(40),
    ]);
    const finalBytes = Buffer.concat([
      Buffer.from(encodeHeader(header({ startedUnix: 2000 }))),
      Buffer.alloc(400),
    ]);
    writeFileSync(join(live, name(TOKEN)), liveBytes);
    writeFileSync(join(replays, name(TOKEN)), finalBytes);
    expect(pruneLiveFiles(db, live, replays, NOW)).toBe(1);
    expect(existsSync(join(live, name(TOKEN)))).toBe(false);
  });

  // An unlink error's message is "EACCES: permission denied, unlink
  // '<dir>/pug_<token>_0_1.rpl'": logging it would put the token in the log.
  it('logs only the error code when a delete fails, never the token', () => {
    put(live, name(TOKEN), 100, 25 * 60 * 60 * 1000);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    chmodSync(live, 0o555);
    try {
      expect(pruneLiveFiles(db, live, replays, NOW)).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(['[replay] could not delete a live file:', 'EACCES']);
      for (const arg of spy.mock.calls.flat()) expect(String(arg)).not.toContain(TOKEN);
    } finally {
      chmodSync(live, 0o755);
      spy.mockRestore();
    }
  });

  it('logs only the error name when a prune run throws, and does not rethrow', () => {
    put(live, name(TOKEN), 100);
    db.close();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => pruneLiveFilesSafely(db, live, replays, NOW)).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      const [label, code] = spy.mock.calls[0];
      expect(label).toBe('[replay] live file prune failed:');
      expect(typeof code).toBe('string');
      expect(code).not.toMatch(/\s/);
      for (const arg of spy.mock.calls.flat()) expect(String(arg)).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
      db = openDb(':memory:');
    }
  });
});
