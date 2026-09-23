import { openSync, readSync, writeSync, closeSync } from 'node:fs';
import type { DB } from './db.js';
import {
  decodeHeader, HEADER_BYTES, TOKEN_OFFSET, TOKEN_BYTES, INFECTED_MASK_OFFSET, SIDES_FLAG_OFFSET,
} from './replayFormat.js';

/**
 * Which roster slots are infected in one round, as the header's version 3
 * side mask, or null when the database cannot say. Roster team plus the
 * round's survivor side, mapped through the file's own slot table. Moved here
 * from routes/replays.ts so the route, the upload and the one-time stamp all
 * compute it the same way.
 */
export function infectedMaskForHeader(
  db: DB, head: Buffer, matchId: number, ordinal: number, half: number,
): number | null {
  const round = db.prepare(
    'SELECT surv_team FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?',
  ).get(matchId, ordinal, half) as { surv_team: 'a' | 'b' } | undefined;
  if (!round) return null;
  const h = decodeHeader(head);
  if (!h) return null;
  const team = new Map(
    (db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[])
      .map((r) => [r.player_id, r.team] as const),
  );
  let mask = 0;
  for (let slot = 0; slot < h.slots.length; slot++) {
    const t = team.get(h.slots[slot]);
    if (t !== undefined && t !== round.surv_team) mask |= 1 << slot;
  }
  return mask;
}

const TOKEN_END = TOKEN_OFFSET + TOKEN_BYTES;

/**
 * Rewrite the header bytes a slice holds, in place. `buf` holds file bytes
 * starting at absolute offset `start`. The token is zeroed wherever the slice
 * overlaps it (it seeds the match's server password), and a slice from 0 that
 * holds the whole header gets the side mask when the file has none.
 */
export function rewriteHead(buf: Buffer, start: number, infectedMask: number | null): void {
  const zeroFrom = Math.max(start, TOKEN_OFFSET) - start;
  const zeroTo = Math.min(start + buf.length, TOKEN_END) - start;
  if (zeroTo > zeroFrom) buf.fill(0, zeroFrom, zeroTo);
  if (infectedMask !== null && start === 0 && buf.length >= HEADER_BYTES && buf[SIDES_FLAG_OFFSET] !== 1) {
    buf[INFECTED_MASK_OFFSET] = infectedMask & 0xff;
    buf[SIDES_FLAG_OFFSET] = 1;
  }
}

/** The bytes that go to R2: a copy, token zeroed, mask stamped when missing. */
export function prepareForUpload(file: Buffer, infectedMask: number | null): Buffer {
  const out = Buffer.from(file);
  rewriteHead(out, 0, infectedMask);
  return out;
}

/** Write the mask into a file's own header, once. Touches bytes 156 and 157
 *  only, and only when the file has no mask. Returns whether it wrote. */
export function stampSidesInFile(path: string, mask: number): boolean {
  const fd = openSync(path, 'r+');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    if (readSync(fd, head, 0, HEADER_BYTES, 0) !== HEADER_BYTES) return false;
    if (head[SIDES_FLAG_OFFSET] === 1) return false;
    writeSync(fd, Buffer.from([mask & 0xff, 1]), 0, 2, INFECTED_MASK_OFFSET);
    return true;
  } finally {
    closeSync(fd);
  }
}
