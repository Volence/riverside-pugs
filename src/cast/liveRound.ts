import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { DB } from '../db.js';
import { roundInProgress } from '../liveView.js';
import { resolveFurther } from '../replaySessions.js';
import {
  decodeFrames, decodeHeader, ENTITY_KIND, frameBytes, HEADER_BYTES, slotInfected, STATE,
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
/** Never read more than this per poll; a reader that fell far behind skips
 *  ahead to the tail instead of decoding minutes of frames it will discard. */
const MAX_CHUNK = 4 * 1024 * 1024;

interface Cursor {
  path: string;
  startedUnix: number;
  header: ReplayHeader;
  /** File offset where the next undecoded frame starts. */
  offset: number;
  last: Frame | null;
  /** Highest health any tank has had in this file: the max for the bar. */
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
    const cur = this.advance(found.path, nowMs);
    this.sweep(nowMs);
    if (!cur?.last) return null;
    let mtimeMs = nowMs;
    try { mtimeMs = statSync(found.path).mtimeMs; } catch { /* keep now */ }
    return summarise(db, cur, Math.max(0, nowMs - mtimeMs));
  }

  private advance(path: string, nowMs: number): Cursor | null {
    let size: number;
    try { size = statSync(path).size; } catch { return null; }
    let cur = this.cursors.get(path);
    const head = readBytes(path, 0, HEADER_BYTES);
    const header = head ? decodeHeader(head) : null;
    if (!header || header.version > VERSION) return null;
    // A restarted round reuses the filename: a new start time or a shorter
    // file means start over.
    if (!cur || cur.startedUnix !== header.startedUnix || size < cur.offset) {
      cur = { path, startedUnix: header.startedUnix, header, offset: HEADER_BYTES, last: null, tankMax: 0, usedAt: nowMs };
      this.cursors.set(path, cur);
    }
    cur.header = header;
    cur.usedAt = nowMs;
    const end = header.indexOffset > 0 && header.indexOffset <= size ? header.indexOffset : size;
    if (end - cur.offset > MAX_CHUNK) {
      // Too far behind to read it all: decode only the tail, starting from a
      // frame boundary found by walking the frame headers (8 bytes each).
      cur.offset = skipTo(path, cur.offset, end - MAX_CHUNK) ?? cur.offset;
    }
    if (end <= cur.offset) return cur;
    const chunk = readBytes(path, cur.offset, Math.min(end - cur.offset, MAX_CHUNK));
    if (!chunk) return cur;
    const { frames } = decodeFrames(chunk, 0, chunk.length, (slot) => slotInfected(header, slot));
    if (frames.length > 0) {
      const lastF = frames[frames.length - 1]!;
      cur.offset += lastF.offset + frameBytes(lastF.entities.length);
      cur.last = lastF;
      for (const f of frames) cur.tankMax = Math.max(cur.tankMax, tankHealth(header, f));
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

/** The first frame boundary at or after `target`, walking frame headers from
 *  a known boundary `from`. */
function skipTo(path: string, from: number, target: number): number | null {
  let at = from;
  const h = new Uint8Array(8);
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    while (at < target) {
      if (readSync(fd, h, 0, 8, at) < 8) return at;
      const count = h[4]! | (h[5]! << 8);
      at += frameBytes(count);
    }
    return at;
  } finally {
    closeSync(fd);
  }
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
      infected.push({ slot: p.slot, steamid, name, cls, ghost, alive, health: alive && !ghost ? p.health : 0 });
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
        weapon: weaponName(p.weapon),
      });
    }
  }
  if (!tank) {
    const ai = f.entities.find((e) => e.kind === ENTITY_KIND.TANK_AI && e.health > 0);
    if (ai) tank = { health: ai.health, maxHealth: Math.max(cur.tankMax, ai.health), controller: null };
  }
  return {
    ordinal: h.ordinal, half: h.half, map: h.map, tMs: f.tMs, ageMs,
    survivors, infected, tank,
    witches: f.entities.filter((e) => e.kind === ENTITY_KIND.WITCH).length,
  };
}
