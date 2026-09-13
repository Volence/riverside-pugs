import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessions, currentFileFor, resolveByName, CLOSED_AFTER_IDLE_MS,
} from '../src/replaySessions.js';
import { encodeHeader, encodeFrame, VERSION, HEADER_BYTES, PLAYER_SLOTS,
  type ReplayHeader, type Frame } from '../src/replayFormat.js';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const NOW = 1_800_000_000_000;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN_A, ordinal: 0, half: 1,
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

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rpl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(name: string, h: ReplayHeader, mtimeMs = NOW): void {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([encodeHeader(h), encodeFrame(emptyFrame(0))]));
  const secs = mtimeMs / 1000;
  utimesSync(path, secs, secs);
}

describe('listSessions', () => {
  it('groups files by token and sorts files by ordinal then half', () => {
    write(`pug_${TOKEN_A}_1_2.rpl`, header({ ordinal: 1, half: 2 }));
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ ordinal: 0, half: 1 }));
    write(`pug_${TOKEN_B}_0_1.rpl`, header({ token: TOKEN_B }));

    const sessions = listSessions(dir, NOW);
    expect(sessions).toHaveLength(2);
    const a = sessions.find((s) => s.token === TOKEN_A)!;
    expect(a.files.map((f) => [f.ordinal, f.half])).toEqual([[0, 1], [1, 2]]);
  });

  it('ignores files that are not replays', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header());
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, `pug_${TOKEN_A}_0_1.dem`), 'demo');
    expect(listSessions(dir, NOW)).toHaveLength(1);
  });

  it('treats a file with a patched frame count as closed', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ frameCount: 900 }));
    expect(listSessions(dir, NOW)[0].files[0].closed).toBe(true);
  });

  it('treats an untouched file as closed once it has gone idle', () => {
    // frameCount 0 means the writer never closed it. A crashed recording
    // would otherwise be treated as live and delayed forever.
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ frameCount: 0 }), NOW - CLOSED_AFTER_IDLE_MS - 1);
    expect(listSessions(dir, NOW)[0].files[0].closed).toBe(true);
  });

  it('treats a recently written file with no frame count as open', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ frameCount: 0 }), NOW - 1000);
    expect(listSessions(dir, NOW)[0].files[0].closed).toBe(false);
  });

  it('returns nothing for a missing directory rather than throwing', () => {
    expect(listSessions(join(dir, 'nope'), NOW)).toEqual([]);
  });

  it('returns nothing when no directory is configured', () => {
    expect(listSessions('', NOW)).toEqual([]);
  });
});

describe('currentFileFor', () => {
  it('picks the highest ordinal and half for the token', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ ordinal: 0, half: 1 }));
    write(`pug_${TOKEN_A}_1_1.rpl`, header({ ordinal: 1, half: 1 }));
    write(`pug_${TOKEN_A}_1_2.rpl`, header({ ordinal: 1, half: 2 }));
    const got = currentFileFor(dir, TOKEN_A, NOW);
    expect(got?.filename).toBe(`pug_${TOKEN_A}_1_2.rpl`);
  });

  it('returns null for an unknown token', () => {
    expect(currentFileFor(dir, TOKEN_B, NOW)).toBeNull();
  });

  it('returns null for a token that is not 32 hex characters', () => {
    expect(currentFileFor(dir, '../../etc/passwd', NOW)).toBeNull();
  });
});

describe('resolveByName', () => {
  it('resolves a well formed name', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header());
    const got = resolveByName(dir, `pug_${TOKEN_A}_0_1.rpl`, NOW);
    expect(got?.path).toBe(join(dir, `pug_${TOKEN_A}_0_1.rpl`));
  });

  it('refuses a traversal attempt', () => {
    expect(resolveByName(dir, '../../../etc/passwd', NOW)).toBeNull();
    expect(resolveByName(dir, `../pug_${TOKEN_A}_0_1.rpl`, NOW)).toBeNull();
  });

  it('refuses a name that does not match the replay pattern', () => {
    writeFileSync(join(dir, 'evil.rpl'), 'x');
    expect(resolveByName(dir, 'evil.rpl', NOW)).toBeNull();
  });

  it('returns null for a name that matches but is not on disk', () => {
    expect(resolveByName(dir, `pug_${TOKEN_B}_0_1.rpl`, NOW)).toBeNull();
  });
});
