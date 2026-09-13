import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { encodeHeader, encodeFrame, HEADER_BYTES, PLAYER_SLOTS, type Frame, type ReplayHeader, VERSION } from '../src/replayFormat.js';
import { discoverMatchReplays, recordMatchReplays, resolveReplayPath } from '../src/replays.js';

/** Whole-file reads seen by src/replays.ts, recorded so a test can assert that
 *  the recovery parse did NOT happen. readFileSync is a precise probe: the
 *  header read uses openSync and readSync, so the only caller of readFileSync
 *  in that module is the parse. A real spy is not possible here because an ESM
 *  namespace object is not configurable, hence the module mock. */
const probe = vi.hoisted(() => ({ wholeFileReads: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      probe.wholeFileReads.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

const TOKEN = 'b'.repeat(32);
let dir: string;

function head(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 1, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1785956274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    infectedMask: 0,
    sidesKnown: false,
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0, entities: [],
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
  };
}

/** Write a closed replay: frames, then an index, with the header patched the
 *  way the plugin patches it at close. */
function writeReplay(name: string, over: Partial<ReplayHeader>, frameCount: number): void {
  const frames = Array.from({ length: frameCount }, (_, i) => encodeFrame(emptyFrame(i * 100)));
  const body = Buffer.concat(frames);
  const index = Buffer.alloc(8);
  index.writeUInt32LE(0, 0);
  index.writeUInt32LE(HEADER_BYTES, 4);
  const h = head({ ...over, frameCount, indexOffset: HEADER_BYTES + body.length, indexCount: 1 });
  writeFileSync(join(dir, name), Buffer.concat([encodeHeader(h), body, index]));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rpl-')); probe.wholeFileReads.length = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('discoverMatchReplays', () => {
  it('finds files for this token and reads frames and rate from the header', () => {
    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    writeReplay(`pug_${TOKEN}_1_2.rpl`, { ordinal: 1, half: 2 }, 5);
    const found = discoverMatchReplays(dir, TOKEN);
    expect(found.map((f) => [f.ordinal, f.half, f.frames, f.sampleHz])).toEqual([
      [1, 1, 3, 10],
      [1, 2, 5, 10],
    ]);
  });

  it('ignores another match token, and anything that is not a replay', () => {
    writeReplay(`pug_${'c'.repeat(32)}_1_1.rpl`, { token: 'c'.repeat(32) }, 2);
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.dem`), 'not a replay');
    writeFileSync(join(dir, 'random.rpl'), 'nope');
    expect(discoverMatchReplays(dir, TOKEN)).toEqual([]);
  });

  it('rejects a file whose header token disagrees with its filename', () => {
    // The name says one match, the bytes say another. Trusting the name would
    // file someone else's round under this match.
    writeReplay(`pug_${TOKEN}_1_1.rpl`, { token: 'd'.repeat(32) }, 2);
    expect(discoverMatchReplays(dir, TOKEN)).toEqual([]);
  });

  it('skips a file too short to hold a header', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_2_1.rpl`), Buffer.alloc(10));
    expect(discoverMatchReplays(dir, TOKEN)).toEqual([]);
  });

  it('counts frames by parsing when the header says zero, which means never closed', () => {
    // A crash leaves frameCount 0. The frames written before it are still
    // good, so the row must report them rather than claim the file is empty.
    const body = Buffer.concat([encodeFrame(emptyFrame(0)), encodeFrame(emptyFrame(100))]);
    writeFileSync(join(dir, `pug_${TOKEN}_3_1.rpl`), Buffer.concat([encodeHeader(head({ ordinal: 3, half: 1 })), body]));
    const found = discoverMatchReplays(dir, TOKEN);
    expect(found).toHaveLength(1);
    expect(found[0].frames).toBe(2);
    expect(found[0].closed).toBe(false);
  });

  it('skips an unclosed file without parsing it when excludeOpen is set', () => {
    // The recovery parse is the whole cost of this path: a finished round is
    // 10 to 15 MB, readFileSync plus parseReplay blocks the event loop, and
    // the round_end caller runs on the request path with this flag set. A
    // caller that is going to discard the row must not pay for it.
    writeReplay(`pug_${TOKEN}_4_1.rpl`, { ordinal: 4, half: 1 }, 3);
    const body = Buffer.concat([encodeFrame(emptyFrame(0)), encodeFrame(emptyFrame(100))]);
    writeFileSync(
      join(dir, `pug_${TOKEN}_4_2.rpl`),
      Buffer.concat([encodeHeader(head({ ordinal: 4, half: 2 })), body]),
    );

    const found = discoverMatchReplays(dir, TOKEN, { excludeOpen: true });
    // Absent, not present with a recovered count of 2.
    expect(found.map((f) => [f.half, f.frames, f.closed])).toEqual([[1, 3, true]]);
    expect(probe.wholeFileReads).toEqual([]);

    // Same directory with the flag off, which is the completion path: the
    // unclosed file is a crashed round worth recording, so it still gets its
    // frames recovered by parsing.
    const all = discoverMatchReplays(dir, TOKEN);
    expect(all.map((f) => [f.half, f.frames, f.closed])).toEqual([[1, 3, true], [2, 2, false]]);
    expect(probe.wholeFileReads).toEqual([join(dir, `pug_${TOKEN}_4_2.rpl`)]);
  });

  it('returns nothing for an unreadable directory rather than throwing', () => {
    expect(discoverMatchReplays(join(dir, 'nope'), TOKEN)).toEqual([]);
  });

  it('returns nothing when the directory is unset, which is the feature-off default', () => {
    expect(discoverMatchReplays('', TOKEN)).toEqual([]);
  });
});

describe('recordMatchReplays', () => {
  it('inserts a row per file and upserts on a second run', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;

    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    expect(recordMatchReplays(db, id, TOKEN, dir)).toBe(1);

    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 9);
    expect(recordMatchReplays(db, id, TOKEN, dir)).toBe(1);

    const rows = db.prepare('SELECT ordinal, half, frames FROM match_replays').all();
    expect(rows).toEqual([{ ordinal: 1, half: 1, frames: 9 }]);
  });

  it('skips a file that is still open when excludeOpen is set', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;

    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    const body = encodeFrame(emptyFrame(0));
    writeFileSync(join(dir, `pug_${TOKEN}_1_2.rpl`), Buffer.concat([encodeHeader(head({ ordinal: 1, half: 2 })), body]));

    expect(recordMatchReplays(db, id, TOKEN, dir, { excludeOpen: true })).toBe(1);
    const rows = db.prepare('SELECT half FROM match_replays').all();
    expect(rows).toEqual([{ half: 1 }]);
  });
});

describe('resolveReplayPath', () => {
  it('resolves a recorded replay to a real path', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;
    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    recordMatchReplays(db, id, TOKEN, dir);
    const got = resolveReplayPath(db, id, 1, 1, dir);
    expect(got!.path).toBe(join(dir, `pug_${TOKEN}_1_1.rpl`));
  });

  it('refuses a row whose filename escapes the replay directory', () => {
    // Rows are only ever written from a filtered listing, so this cannot
    // happen from the normal path. It is checked anyway because a database
    // value flowing into a file read is exactly how one bad row becomes
    // arbitrary file disclosure.
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;
    db.prepare(
      `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
       VALUES (?, 1, 1, '../../etc/passwd', 1, 1, 10)`,
    ).run(id);
    expect(resolveReplayPath(db, id, 1, 1, dir)).toBeNull();
  });

  it('returns null for a pruned replay whose row outlived its file', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;
    db.prepare(
      `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
       VALUES (?, 1, 1, ?, 1, 1, 10)`,
    ).run(id, `pug_${TOKEN}_1_1.rpl`);
    expect(resolveReplayPath(db, id, 1, 1, dir)).toBeNull();
  });
});
