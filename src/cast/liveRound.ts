import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { DB } from '../db.js';
import { roundInProgress } from '../liveView.js';
import { resolveFurther } from '../replaySessions.js';
import { infectedMaskForHeader } from '../replaySides.js';
import {
  decodeFrames, decodeHeader, ENTITY_KIND, ENTITY_RECORD_BYTES, FRAME_HEADER_BYTES, frameBytes, HEADER_BYTES, PLAYER_BLOCK_BYTES, PLAYER_RECORD_BYTES, slotInfected, STATE,
  SURVIVOR_CHARACTERS, VERSION, weaponName, ZOMBIE_CLASSES, type Frame, type ReplayHeader,
} from '../replayFormat.js';
import type { CastInfected, CastLiveRound, CastSurvivor } from './types.js';

/**
 * The live round HUD's data: the newest frame of the round being played,
 * read straight from the replay file the plugin pushes (pug-match 0.3.6 live
 * push). Casters get no delay (spec), so there is no cutoff here: this module
 * must only ever be reached through the caster gate in src/cast/access.ts.
 *
 * A live file grows to 15 MB and every overlay polls once a second, so each
 * file is read incrementally: the reader remembers where its last complete
 * frame ended and decodes only bytes added since.
 */

/** Recorded temp health at or below this means none (the plugin writes
 *  temp=1 for every survivor with none: see web/src/replay/hud.ts). */
const TEMP_NOISE_FLOOR = 1;
/** Never decode more than this per poll. A first read of a long round, or a
 *  reader that fell far behind, starts this far from the end instead of
 *  decoding minutes of frames it would throw away. About 30 seconds of
 *  frames, enough for the tank max (see tankMax) to be close. */
const TAIL_BYTES = 128 * 1024;

interface Cursor {
  path: string;
  startedUnix: number;
  header: ReplayHeader;
  /** File offset where the next undecoded frame starts. */
  offset: number;
  last: Frame | null;
  /** The newest frame that sampled entities. The plugin samples entities on
   *  one frame in N (entity Hz below player Hz), so most frames carry none and
   *  reading AI tanks, witches and bots off `last` alone would flicker. */
  lastEnt: Frame | null;
  /** Highest health any tank has had in what this reader decoded: the max for
   *  the bar. A reader that started mid-tank (first read of a long round only
   *  decodes the tail) sees less than the spawn health, so the bar starts too
   *  full until the tank's next spawn; accepted. */
  tankMax: number;
  usedAt: number;
}

export class LiveRoundReader {
  private cursors = new Map<string, Cursor>();

  constructor(private readonly replayDir: string, private readonly liveDir: string) {}

  /** The newest frame of `matchId`'s round in progress, or null between
   *  rounds, with no file yet, or when the push is off for that box. */
  read(db: DB, matchId: number, nowMs = Date.now()): CastLiveRound | null {
    const rip = roundInProgress(db, matchId);
    if (!rip) return null;
    const row = db.prepare('SELECT token FROM matches WHERE id = ?').get(matchId) as { token: string | null } | undefined;
    if (!row?.token) return null;
    const found = resolveFurther(this.replayDir, this.liveDir, `pug_${row.token}_${rip.ordinal}_${rip.half}.rpl`, nowMs);
    if (!found) return null;
    const cur = this.advance(db, matchId, found.path, nowMs);
    this.sweep(nowMs);
    if (!cur?.last) return null;
    let mtimeMs = nowMs;
    try { mtimeMs = statSync(found.path).mtimeMs; } catch { /* keep now */ }
    return summarise(db, cur, Math.max(0, nowMs - mtimeMs));
  }

  private advance(db: DB, matchId: number, path: string, nowMs: number): Cursor | null {
    let size: number;
    try { size = statSync(path).size; } catch { return null; }
    let cur = this.cursors.get(path);
    const head = readBytes(path, 0, HEADER_BYTES);
    const header = head ? decodeHeader(head) : null;
    if (!header || header.version > VERSION) return null;
    // A file from before the side mask (or one whose writer never filled it):
    // the sides come from the round's survivor team and the roster, as the
    // replay route works them out, never from slot order.
    if (!header.sidesKnown && head) {
      const mask = infectedMaskForHeader(db, Buffer.from(head), matchId, header.ordinal, header.half);
      if (mask !== null) { header.infectedMask = mask; header.sidesKnown = true; }
    }
    // A restarted round reuses the filename: a new start time or a shorter
    // file means start over.
    if (!cur || cur.startedUnix !== header.startedUnix || size < cur.offset) {
      cur = { path, startedUnix: header.startedUnix, header, offset: HEADER_BYTES, last: null, lastEnt: null, tankMax: 0, usedAt: nowMs };
      this.cursors.set(path, cur);
    }
    cur.header = header;
    cur.usedAt = nowMs;
    const end = header.indexOffset > 0 && header.indexOffset <= size ? header.indexOffset : size;
    if (end - cur.offset > TAIL_BYTES) {
      // A first read of a long round (or a reader far behind): only the tail
      // matters, and walking the whole file would block the event loop. Find
      // a frame boundary near the start of the tail window and go from there.
      const from = end - TAIL_BYTES;
      const window = readBytes(path, from, TAIL_BYTES);
      const at = window ? findFrameBoundary(window) : null;
      if (at === null) return cur;
      cur.offset = from + at;
    }
    if (end <= cur.offset) return cur;
    const chunk = readBytes(path, cur.offset, end - cur.offset);
    if (!chunk) return cur;
    const { frames } = decodeFrames(chunk, 0, chunk.length, (slot) => slotInfected(header, slot));
    if (frames.length > 0) {
      const lastF = frames[frames.length - 1]!;
      cur.offset += lastF.offset + frameBytes(lastF.entities.length);
      cur.last = lastF;
      for (const f of frames) {
        cur.tankMax = Math.max(cur.tankMax, tankHealth(header, f));
        if (f.entities.length > 0) cur.lastEnt = f;
      }
    }
    return cur;
  }

  /** Forget files nobody has asked about for ten minutes. */
  private sweep(nowMs: number): void {
    for (const [k, c] of this.cursors) if (nowMs - c.usedAt > 600_000) this.cursors.delete(k);
  }
}

function readBytes(path: string, at: number, len: number): Uint8Array | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = new Uint8Array(len);
    const n = readSync(fd, buf, 0, len, at);
    return n === len ? buf : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The largest entity count a plausible frame carries. Commons, witches,
 *  rocks and bots together stay well under this; garbage read as a count
 *  usually does not. */
const MAX_ENTITIES = 128; // RPL_MAX_ENTITIES in plugin/pug-match.sp

/**
 * Where the first whole frame starts in a window cut from the middle of a
 * file, or null. Frames carry no sync marker, so each candidate offset is
 * checked by walking frame lengths from it: every frame on the way must have
 * a sane entity count, entity kinds the format knows, player states that
 * make sense, and a clock that moves forward by at most ten seconds, and the walk must reach
 * the end of the window (a trailing part frame is fine). Only the first
 * frame's worth of offsets can hold the boundary, so only those are tried.
 * Exported for tests.
 */
export function findFrameBoundary(buf: Uint8Array): number | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const limit = Math.min(buf.length, frameBytes(MAX_ENTITIES));
  const KINDS = new Set<number>(Object.values(ENTITY_KIND));
  for (let start = 0; start < limit; start++) {
    let off = start;
    let prevT = -1;
    let frames = 0;
    let ok = true;
    while (off + FRAME_HEADER_BYTES <= buf.length) {
      const t = v.getUint32(off, true);
      const count = v.getUint16(off + 4, true);
      // The clock moves forward every frame (the writer samples at a fixed rate).
      if (count > MAX_ENTITIES || (prevT >= 0 && (t <= prevT || t - prevT > 10_000))) { ok = false; break; }
      const size = frameBytes(count);
      if (off + size > buf.length) break; // the trailing part frame
      // A player state with any bit set has PRESENT set (an empty slot is all zero).
      for (let slot = 0; slot < 8; slot++) {
        const st = buf[off + FRAME_HEADER_BYTES + slot * PLAYER_RECORD_BYTES + 9]!;
        if (st !== 0 && (st & STATE.PRESENT) === 0) { ok = false; break; }
      }
      if (!ok) break;
      for (let e = 0; e < count; e++) {
        if (!KINDS.has(buf[off + FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES + e * ENTITY_RECORD_BYTES + 2]!)) { ok = false; break; }
      }
      if (!ok) break;
      prevT = t;
      frames++;
      off += size;
    }
    if (ok && frames >= 2) return start;
  }
  return null;
}

function tankHealth(h: ReplayHeader, f: Frame): number {
  let best = 0;
  for (const p of f.players) {
    if (p.state & STATE.PRESENT && p.state & STATE.ALIVE && slotInfected(h, p.slot) && ZOMBIE_CLASSES[p.cls] === 'tank' && !(p.state & STATE.GHOST)) {
      best = Math.max(best, p.health);
    }
  }
  for (const e of f.entities) if (e.kind === ENTITY_KIND.TANK_AI) best = Math.max(best, e.health);
  return best;
}

function summarise(db: DB, cur: Cursor, ageMs: number): CastLiveRound {
  const h = cur.header;
  const f = cur.last!;
  const ids = h.slots.filter(Boolean);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = db.prepare(`SELECT steamid, name FROM players WHERE steamid IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { steamid: string; name: string }[];
    for (const r of rows) names.set(r.steamid, r.name);
  }
  const survivors: CastSurvivor[] = [];
  const infected: CastInfected[] = [];
  let tank: CastLiveRound['tank'] = null;
  for (const p of f.players) {
    const steamid = h.slots[p.slot] ?? '';
    if (!steamid || !(p.state & STATE.PRESENT)) continue;
    const alive = (p.state & STATE.ALIVE) !== 0;
    const name = names.get(steamid) ?? steamid;
    if (slotInfected(h, p.slot)) {
      const cls = ZOMBIE_CLASSES[p.cls] ?? '';
      const ghost = (p.state & STATE.GHOST) !== 0;
      infected.push({ slot: p.slot, steamid, name, cls, ghost, alive, health: alive && !ghost ? p.health : 0, dmg: null });
      if (cls === 'tank' && alive && !ghost) {
        tank = { health: p.health, maxHealth: Math.max(cur.tankMax, p.health), controller: name };
      }
    } else {
      const character = h.version >= 2 ? SURVIVOR_CHARACTERS[p.cls] ?? '' : '';
      survivors.push({
        slot: p.slot, steamid, name, character,
        health: alive ? p.health : 0,
        temp: alive && p.temp > TEMP_NOISE_FLOOR ? p.temp : 0,
        alive,
        incap: (p.state & STATE.INCAP) !== 0,
        ledge: (p.state & STATE.LEDGED) !== 0,
        pinned: (p.state & STATE.PINNED) !== 0,
        biled: (p.state & STATE.BILED) !== 0,
        weapon: weaponName(p.weapon),
        flow: null, items: null, dmg: null,
      });
    }
  }
  const ents = cur.lastEnt?.entities ?? [];
  // Survivor bots (a survivor slot nobody holds) are entities, not roster
  // slots: listed after the players, with no name or character to show.
  for (const e of ents) {
    if (e.kind !== ENTITY_KIND.SURVIVOR_BOT || survivors.length >= 4) continue;
    const alive = (e.state & STATE.ALIVE) !== 0 || (e.state === 0 && e.health > 0);
    survivors.push({
      slot: -1, steamid: '', name: 'Bot', character: '', health: alive ? e.health : 0, temp: 0, alive,
      incap: (e.state & STATE.INCAP) !== 0, ledge: (e.state & STATE.LEDGED) !== 0, pinned: (e.state & STATE.PINNED) !== 0,
      biled: (e.state & STATE.BILED) !== 0, weapon: '', flow: null, items: null, dmg: null,
    });
  }
  if (!tank) {
    const ai = ents.find((e) => e.kind === ENTITY_KIND.TANK_AI && e.health > 0);
    if (ai) tank = { health: ai.health, maxHealth: Math.max(cur.tankMax, ai.health), controller: null };
  }
  return {
    ordinal: h.ordinal, half: h.half, map: h.map, tMs: f.tMs, ageMs,
    survivors, infected, tank,
    witches: ents.filter((e) => e.kind === ENTITY_KIND.WITCH).length,
    hud: null,
  };
}
