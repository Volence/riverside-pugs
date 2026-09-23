import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  encodeHeader, encodeFrame, VERSION, PLAYER_SLOTS, SIDES_FLAG_OFFSET,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';
import { offloadReplay, sweepReplays, REPLAY_QUIET_MS } from '../src/replayOffload.js';
import type { R2Ops } from '../src/demoOffload.js';
import type { R2Config } from '../src/r2.js';

const CFG: R2Config = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'riverside-replays',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'SECRETEXAMPLE',
  publicUrl: 'https://pub-abc.r2.dev',
};

const TOKEN = 'a'.repeat(32);
const FILE = `pug_${TOKEN}_0_1.rpl`;
const A = ['11', '12', '13', '14'].map((n) => `765611980000000${n}`);
const B = ['21', '22', '23', '24'].map((n) => `765611980000000${n}`);

// Copied from tests/replayRoutes.test.ts, which is where the canonical
// version of these two fixture builders lives.
function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: Math.floor(Date.now() / 1000) - 600,
    indexOffset: 0, indexCount: 0, frameCount: 0,
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

/** Fake ops from the brief. Captures the uploaded bytes by reading the temp
 *  file inside `put`, and refuses ever to be asked to delete: the sweep must
 *  never touch the local copy. */
function fakeOps(opts: { failPut?: boolean; lieSize?: boolean } = {}) {
  const uploads = new Map<string, Buffer>();
  const ops: R2Ops = {
    async put(_c, key, path) {
      if (opts.failPut) throw new Error('boom');
      const b = readFileSync(path); uploads.set(key, b); return { bytes: b.length };
    },
    async head(_c, key) {
      const b = uploads.get(key);
      return b ? { bytes: opts.lieSize ? b.length - 1 : b.length } : null;
    },
    async remove() { throw new Error('the sweep must never delete'); },
  };
  return { ops, uploads };
}

let db: DB;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'replayoffload-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A distinct filename token per match, so several match_replays rows in one
 *  test can each have their own file on disk without colliding. */
function tok(n: number): string {
  return n.toString(16).padStart(32, '0');
}

/** Write a closed (frameCount > 0) or still-open (frameCount 0) replay file
 *  and return its path. */
function writeReplayFile(filename: string, frames: number, over: Partial<ReplayHeader> = {}): string {
  const parts: Buffer[] = [Buffer.from(encodeHeader(header({ frameCount: frames, ...over })))];
  for (let i = 0; i < frames; i++) parts.push(Buffer.from(encodeFrame(emptyFrame(i * 1000))));
  const path = join(dir, filename);
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

function setMtimeMinutesAgo(path: string, minutes: number): void {
  const t = (Date.now() - minutes * 60_000) / 1000;
  utimesSync(path, t, t);
}

function seedMatch(id: number, state: string): void {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (?, 1, ?, 'dead_air', ?)")
    .run(id, state, TOKEN);
}

function seedReplayRow(
  matchId: number, ordinal: number, half: number, filename: string, bytes: number, frames: number,
  opts: { r2Key?: string; prunedAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz, r2_key, pruned_at)
     VALUES (?, ?, ?, ?, ?, ?, 10, ?, ?)`,
  ).run(matchId, ordinal, half, filename, bytes, frames, opts.r2Key ?? null, opts.prunedAt ?? null);
}

function seedRoster(matchId: number): void {
  for (const p of [...A, ...B]) db.prepare("INSERT OR IGNORE INTO players (steamid, name) VALUES (?, 'p')").run(p);
  for (const p of A) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(matchId, p);
  for (const p of B) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'b')").run(matchId, p);
}

function seedRound(matchId: number, ordinal: number, half: number, survTeam: 'a' | 'b' = 'a'): void {
  db.prepare('INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (?, ?, ?, ?)').run(matchId, ordinal, half, survTeam);
}

describe('sweepReplays', () => {
  it('uploads a closed, quiet replay of a finished match under the tokenless key, blanked and stamped', async () => {
    seedMatch(7, 'completed');
    seedRoster(7);
    seedRound(7, 0, 1, 'a');
    const path = writeReplayFile(FILE, 5, { slots: [...A, ...B] });
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(7, 0, 1, FILE, statSync(path).size, 5);

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
    const body = uploads.get('replays/7/0_1.rpl')!;
    expect(body.includes(Buffer.from(TOKEN))).toBe(false);
    expect(body[SIDES_FLAG_OFFSET]).toBe(1);
    const row = db.prepare('SELECT r2_key, r2_at FROM match_replays WHERE match_id = 7').get() as any;
    expect(row.r2_key).toBe('replays/7/0_1.rpl');
    expect(row.r2_at).toBeTruthy();
    expect(existsSync(join(dir, FILE))).toBe(true); // never deleted
  });

  it('also takes aborted matches', async () => {
    seedMatch(8, 'aborted');
    const file = `pug_${tok(8)}_0_1.rpl`;
    const path = writeReplayFile(file, 3);
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(8, 0, 1, file, statSync(path).size, 3);

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
    expect(uploads.has('replays/8/0_1.rpl')).toBe(true);
    const row = db.prepare('SELECT r2_key FROM match_replays WHERE match_id = 8').get() as any;
    expect(row.r2_key).toBe('replays/8/0_1.rpl');
  });

  it('skips a live match', async () => {
    seedMatch(9, 'live');
    const file = `pug_${tok(9)}_0_1.rpl`;
    const path = writeReplayFile(file, 3);
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(9, 0, 1, file, statSync(path).size, 3);

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 0, skipped: 0, failed: 0 });
    expect(uploads.size).toBe(0);
  });

  it('skips a file still being written', async () => {
    seedMatch(10, 'completed');
    const file = `pug_${tok(10)}_0_1.rpl`;
    const path = writeReplayFile(file, 0); // frameCount stays 0: never closed
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(10, 0, 1, file, statSync(path).size, 0);

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 0, skipped: 1, failed: 0 });
    expect(uploads.size).toBe(0);
  });

  it('skips a file changed inside the quiet period', async () => {
    seedMatch(11, 'completed');
    const file = `pug_${tok(11)}_0_1.rpl`;
    const path = writeReplayFile(file, 3);
    setMtimeMinutesAgo(path, 5); // inside the 10 minute REPLAY_QUIET_MS window
    seedReplayRow(11, 0, 1, file, statSync(path).size, 3);

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 0, skipped: 1, failed: 0 });
    expect(uploads.size).toBe(0);
  });

  it('skips rows already uploaded or already pruned', async () => {
    seedMatch(12, 'completed');
    const fileA = `pug_${tok(12)}_0_1.rpl`;
    const pathA = writeReplayFile(fileA, 3);
    setMtimeMinutesAgo(pathA, 20);
    seedReplayRow(12, 0, 1, fileA, statSync(pathA).size, 3, { r2Key: 'replays/12/0_1.rpl' });

    const fileB = `pug_${tok(12)}_1_1.rpl`;
    const pathB = writeReplayFile(fileB, 3);
    setMtimeMinutesAgo(pathB, 20);
    seedReplayRow(12, 1, 1, fileB, statSync(pathB).size, 3, { prunedAt: '2026-09-23T00:00:00Z' });

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 0, skipped: 0, failed: 0 });
    expect(uploads.size).toBe(0);
  });

  it('leaves the row alone when the upload fails', async () => {
    seedMatch(13, 'completed');
    const file = `pug_${tok(13)}_0_1.rpl`;
    const path = writeReplayFile(file, 3);
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(13, 0, 1, file, statSync(path).size, 3);

    const { ops, uploads } = fakeOps({ failPut: true });
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 0, skipped: 0, failed: 1 });
    const row = db.prepare('SELECT r2_key FROM match_replays WHERE match_id = 13').get() as any;
    expect(row.r2_key).toBeNull();
    expect(uploads.size).toBe(0);
  });

  it('does not record an upload whose size does not match', async () => {
    seedMatch(14, 'completed');
    const file = `pug_${tok(14)}_0_1.rpl`;
    const path = writeReplayFile(file, 3);
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(14, 0, 1, file, statSync(path).size, 3);

    const { ops, uploads } = fakeOps({ lieSize: true });
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 0, skipped: 0, failed: 1 });
    const row = db.prepare('SELECT r2_key FROM match_replays WHERE match_id = 14').get() as any;
    expect(row.r2_key).toBeNull();
    expect(uploads.has('replays/14/0_1.rpl')).toBe(true); // the PUT itself "landed", only HEAD lied
  });

  it('uploads without a mask when the sides are unknown, token still blanked', async () => {
    seedMatch(15, 'completed'); // no match_rounds row seeded, so no mask resolves
    const file = `pug_${tok(15)}_0_1.rpl`;
    const path = writeReplayFile(file, 3);
    setMtimeMinutesAgo(path, 20);
    seedReplayRow(15, 0, 1, file, statSync(path).size, 3);

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
    const body = uploads.get('replays/15/0_1.rpl')!;
    expect(body.includes(Buffer.from(TOKEN))).toBe(false);
    expect(body[SIDES_FLAG_OFFSET]).toBe(0);
  });

  it('respects the limit, oldest match first', async () => {
    for (const id of [5, 6, 7]) {
      seedMatch(id, 'completed');
      const file = `pug_${tok(id)}_0_1.rpl`;
      const path = writeReplayFile(file, 3);
      setMtimeMinutesAgo(path, 20);
      seedReplayRow(id, 0, 1, file, statSync(path).size, 3);
    }

    const { ops, uploads } = fakeOps();
    const r = await sweepReplays(db, CFG, dir, { ops, limit: 2, nowMs: Date.now() });
    expect(r).toEqual({ uploaded: 2, skipped: 0, failed: 0 });
    expect(uploads.has('replays/5/0_1.rpl')).toBe(true);
    expect(uploads.has('replays/6/0_1.rpl')).toBe(true);
    expect(uploads.has('replays/7/0_1.rpl')).toBe(false);

    const rows = db.prepare('SELECT match_id AS matchId, r2_key AS r2Key FROM match_replays ORDER BY match_id')
      .all() as { matchId: number; r2Key: string | null }[];
    expect(rows.find((x) => x.matchId === 5)!.r2Key).toBe('replays/5/0_1.rpl');
    expect(rows.find((x) => x.matchId === 6)!.r2Key).toBe('replays/6/0_1.rpl');
    expect(rows.find((x) => x.matchId === 7)!.r2Key).toBeNull();
  });
});

describe('REPLAY_QUIET_MS', () => {
  it('is ten minutes', () => {
    expect(REPLAY_QUIET_MS).toBe(10 * 60 * 1000);
  });
});

describe('offloadReplay', () => {
  it('does not check eligibility: uploads a fresh, still-open file if asked directly', async () => {
    seedMatch(20, 'live');
    const file = `pug_${tok(20)}_0_1.rpl`;
    const path = writeReplayFile(file, 0); // open file, frameCount 0
    seedReplayRow(20, 0, 1, file, statSync(path).size, 0);

    const { ops, uploads } = fakeOps();
    const result = await offloadReplay(db, CFG, { matchId: 20, ordinal: 0, half: 1 }, path, { ops });
    expect(result).toBe('uploaded');
    expect(uploads.has('replays/20/0_1.rpl')).toBe(true);
    const row = db.prepare('SELECT r2_key FROM match_replays WHERE match_id = 20').get() as any;
    expect(row.r2_key).toBe('replays/20/0_1.rpl');
  });
});
