import { readFileSync } from 'node:fs';
import type { DB } from '../db.js';
import { decodeFrames, decodeHeader, HEADER_BYTES, slotInfected, VERSION } from '../replayFormat.js';
import { unpausedFrames } from '../integrity/round.js';
import { resolveReplayPath } from '../replays.js';
import { infectedMaskFor } from '../routes/replays.js';
import type { RoundKey, RoundReplay } from './types.js';

/** A gap between two kept frames longer than this is a hole in the file, not play. */
export const FRAME_DT_CAP_MS = 1000;

/** Decode one round's bytes with the real sides and without paused frames.
 *  `fallbackMask` supplies the side mask for files older than format 3; null
 *  there means the sides cannot be trusted and the round gets no replay. */
export function decodeRoundReplay(buf: Uint8Array, fallbackMask: () => number | null): RoundReplay | null {
  const h = decodeHeader(buf);
  if (!h) return null;
  // A newer writer may have changed a record's size or the meaning of a
  // field, so decoding frames below would produce plausible nonsense rather
  // than an error. Same ceiling parseReplay applies, for the same reason.
  if (h.version > VERSION) return null;
  let sideOf: (slot: number) => boolean;
  if (h.sidesKnown) sideOf = (s) => slotInfected(h, s);
  else {
    const mask = fallbackMask();
    if (mask === null) return null;
    sideOf = (s) => ((mask >> s) & 1) === 1;
  }
  const end = h.indexOffset > 0 && h.indexOffset <= buf.length ? h.indexOffset : buf.length;
  const frames = unpausedFrames(decodeFrames(buf, HEADER_BYTES, end, sideOf).frames);
  if (frames.length < 2) return null;
  let durationMs = 0;
  for (let i = 0; i + 1 < frames.length; i++) {
    durationMs += Math.min(frames[i + 1].tMs - frames[i].tMs, FRAME_DT_CAP_MS);
  }
  durationMs += Math.round(1000 / (h.playerHz > 0 ? h.playerHz : 10));
  return { frames, durationMs, slots: h.slots };
}

/** The round's replay from disk, or null when there is none, it was pruned,
 *  it cannot be read, or its sides cannot be established. */
export function loadRoundReplay(db: DB, key: RoundKey, replayDir: string): RoundReplay | null {
  const found = resolveReplayPath(db, key.matchId, key.ordinal, key.half, replayDir);
  if (!found) return null;
  let buf: Buffer;
  try { buf = readFileSync(found.path); } catch { return null; }
  return decodeRoundReplay(buf, () => infectedMaskFor(db, found.path, key.matchId, key.ordinal, key.half));
}
