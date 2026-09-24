import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  encodeHeader, VERSION, HEADER_BYTES, TOKEN_OFFSET, TOKEN_BYTES,
  INFECTED_MASK_OFFSET, SIDES_FLAG_OFFSET, type ReplayHeader,
} from '../src/replayFormat.js';
import { infectedMaskForHeader, rewriteHead, prepareForUpload, stampSidesInFile } from '../src/replaySides.js';

const TOKEN = 'b'.repeat(32);
const A = ['11', '12', '13', '14'].map((n) => `765611980000000${n}`);
const B = ['21', '22', '23', '24'].map((n) => `765611980000000${n}`);

function head(over: Partial<ReplayHeader> = {}): Buffer {
  return Buffer.from(encodeHeader({
    version: VERSION, token: TOKEN, ordinal: 0, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_farm01_hilltop', startedUnix: 1_700_000_000, indexOffset: 0, indexCount: 0,
    frameCount: 5, slots: [...A, ...B], infectedMask: 0, sidesKnown: false, ...over,
  }));
}

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'rplsides-'));
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (7, 1, 'completed', 'x', ?)").run(TOKEN);
  for (const p of [...A, ...B]) db.prepare("INSERT OR IGNORE INTO players (steamid, name) VALUES (?, 'p')").run(p);
  for (const p of A) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'a')").run(p);
  for (const p of B) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'b')").run(p);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (7, 0, 1, 'a')").run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('the mask and flag are adjacent bytes, which stampSidesInFile relies on', () => {
  expect(SIDES_FLAG_OFFSET).toBe(INFECTED_MASK_OFFSET + 1);
});

describe('infectedMaskForHeader', () => {
  it('marks the slots of the team that did not survive', () => {
    expect(infectedMaskForHeader(db, head(), 7, 0, 1)).toBe(0b11110000);
  });
  it('is null when the round side is unknown', () => {
    expect(infectedMaskForHeader(db, head(), 7, 3, 2)).toBeNull();
  });
});

describe('rewriteHead', () => {
  it('zeroes the token and stamps the mask on a slice from 0', () => {
    const b = head();
    rewriteHead(b, 0, 0b11110000);
    expect(b.subarray(TOKEN_OFFSET, TOKEN_OFFSET + TOKEN_BYTES).every((x) => x === 0)).toBe(true);
    expect(b[INFECTED_MASK_OFFSET]).toBe(0b11110000);
    expect(b[SIDES_FLAG_OFFSET]).toBe(1);
  });
  it('keeps a mask the writer already set', () => {
    const b = head({ infectedMask: 0b00001111, sidesKnown: true });
    rewriteHead(b, 0, 0b11110000);
    expect(b[INFECTED_MASK_OFFSET]).toBe(0b00001111);
  });
  it('zeroes only the token bytes a partial slice holds, and never stamps it', () => {
    const full = head();
    const from = TOKEN_OFFSET + 10;
    const slice = Buffer.from(full.subarray(from));
    rewriteHead(slice, from, 0b11110000);
    expect(slice.subarray(0, TOKEN_BYTES - 10).every((x) => x === 0)).toBe(true);
    expect(slice[INFECTED_MASK_OFFSET - from]).toBe(full[INFECTED_MASK_OFFSET]);
  });
  it('leaves a slice past the header untouched', () => {
    const b = Buffer.from([1, 2, 3]);
    rewriteHead(b, HEADER_BYTES + 5, 1);
    expect([...b]).toEqual([1, 2, 3]);
  });
});

describe('prepareForUpload', () => {
  it('returns a blanked, stamped copy and leaves the input alone', () => {
    const file = Buffer.concat([head(), Buffer.from([9, 9, 9])]);
    const out = prepareForUpload(file, 0b11110000);
    expect(out.includes(Buffer.from(TOKEN))).toBe(false);
    expect(file.includes(Buffer.from(TOKEN))).toBe(true);
    expect(out[SIDES_FLAG_OFFSET]).toBe(1);
    expect(out.subarray(HEADER_BYTES)).toEqual(file.subarray(HEADER_BYTES));
  });
});

describe('stampSidesInFile', () => {
  it('writes only bytes 156 and 157', () => {
    const p = join(dir, 'f.rpl');
    const before = Buffer.concat([head(), Buffer.from([1, 2, 3])]);
    writeFileSync(p, before);
    expect(stampSidesInFile(p, 0b11110000)).toBe(true);
    const after = readFileSync(p);
    const diff = [...after].flatMap((x, i) => (x !== before[i] ? [i] : []));
    expect(diff.every((i) => i === INFECTED_MASK_OFFSET || i === SIDES_FLAG_OFFSET)).toBe(true);
    expect(after[SIDES_FLAG_OFFSET]).toBe(1);
  });
  it('does nothing to a file that already has a mask', () => {
    const p = join(dir, 'g.rpl');
    writeFileSync(p, head({ infectedMask: 3, sidesKnown: true }));
    expect(stampSidesInFile(p, 0b11110000)).toBe(false);
    expect(readFileSync(p)[INFECTED_MASK_OFFSET]).toBe(3);
  });
});
